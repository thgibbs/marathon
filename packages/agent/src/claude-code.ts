import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { newId } from "@marathon/core";
import type { SecretStore } from "@marathon/config";
import { ModelRegistry, parseModelRef, resolveApiKey } from "@marathon/model-gateway";
import { type ContainerMount, serveToolBroker, type ToolGateway } from "@marathon/tools";
import type { GovernedToolsConfig } from "./pi";
import {
  ClaudeStreamAccumulator,
  interpretResult,
  parseStreamJsonLine,
} from "./claude-stream";
import type {
  AgentRequest,
  AgentRuntime,
  AgentTurn,
  AgentTurnContext,
  AgentWorkspaceBinding,
  ModelInvocationData,
} from "./types";

/**
 * Real Claude Code (headless) harness adapter — the second `AgentRuntime` behind
 * the seam (design §7.5, roadmap K7; full reference in `claude-code-impl.md`).
 *
 * One harness turn = one `claude -p --output-format stream-json` invocation inside
 * the task's hardened container (Pattern 1, §12.6): the agent loop runs *in* the
 * sandbox, its Bash/Read/Write/Edit tools are contained by construction, governed
 * tools are brokered back to the host over a per-task unix socket via a stdio MCP
 * shim, and the model call exits only through the host-side key-injecting proxy.
 * `--max-turns` bounds the invocation so the checkpoint cadence is a config knob
 * (§11.2); the session JSONL under `CLAUDE_CONFIG_DIR` is snapshotted per completed
 * invocation and resumed with `--resume`.
 */

/** The subset of {@link DockerContainer} the runtime drives (so a fake can stand in for tests/demos). */
export interface AgentContainer {
  start(): Promise<void>;
  stop(): Promise<void>;
  execStream(
    argv: string[],
    opts?: {
      onData?: (chunk: Buffer) => void;
      input?: string | Buffer;
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>;
}

/** Guest-side conventions inside the container (claude-code-impl.md §5.1). */
const GUEST_WORKSPACE = "/workspace";
export const GUEST_HOME = "/workspace/.marathon-home";
export const GUEST_CONFIG_DIR = "/workspace/.marathon-home/.claude";
export const GUEST_BROKER_SOCKET = "/run/marathon/broker.sock";
export const GUEST_MCP_CONFIG = "/workspace/.marathon-home/mcp.json";
/** Neutral prompt used to resume an invocation that stopped on `--max-turns` (§2.1). */
export const CONTINUATION_PROMPT = "Continue with the task.";

export interface ClaudeCodeAgentOptions {
  /**
   * Host-side secret store. In proxy mode the model key never enters the
   * container (the proxy injects it host-side); in **direct mode** (the bridge
   * default, §4.1) the Marathon Anthropic key from here is injected into the
   * container at launch as a low-blast-radius spend credential. Business
   * credentials (GitHub/Slack/document) never enter the sandbox in either mode.
   */
  secrets: SecretStore;
  registry?: ModelRegistry;
  /** Per-task session snapshots (as {@link PiAgentOptions.sessionDir}). */
  sessionDir?: string;
  /** REQUIRED — this harness runs the whole loop inside a container. */
  sandbox: {
    createContainer: (
      req: AgentRequest,
      workspace: AgentWorkspaceBinding | undefined,
      extra?: { mounts?: ContainerMount[] },
    ) => Promise<AgentContainer> | AgentContainer;
  };
  /** Governed tools, served via broker + MCP shim (same spec list as Pi). */
  governed?: GovernedToolsConfig;
  /**
   * The model proxy (§4.1) — **optional on `network: bridge`** (direct key
   * injection is the default there; see resolveModelAccessEnv), **required
   * under locked-down egress** (`network: none`), where it is the sole route to
   * the model API. When set, `baseUrl` MUST be an endpoint the *container* can
   * reach (a host-visible address, or the internal-network proxy alias in the
   * locked-down posture) — NOT a host-loopback address, which resolves to the
   * container itself. The proxy is a separate long-lived deployment component
   * (`AnthropicKeyProxy`) that injects the key host-side.
   */
  proxy?: { baseUrl?: string };
  /** Checkpoint cadence (§2.1); default 10. */
  maxTurnsPerInvocation?: number;
  /** Expose `ask_user` over MCP (§2.3). */
  clarification?: boolean;
  /** Disallow client-side `WebFetch` (locked-down egress posture, §3.3/§7.1). */
  lockedDownEgress?: boolean;
  /**
   * Read-only tool surface (chat-repo.md §3.4): disallow the built-in
   * file-*mutating* tools so a grounded chat agent can read the checkout but
   * not change it, even via a shell. Governed MCP tools (`document.*`,
   * `github.read_*`) are unaffected — they route through the gateway. Pairs
   * with the `:ro` workspace mount; each guard stands alone.
   */
  readOnly?: boolean;
  cli?: {
    /** The `claude` binary inside the container (default "claude"; a fake stub via demos). */
    bin?: string;
    /** Guest path of the Marathon-managed settings.json (§3.3). */
    settingsPath?: string;
    /** The MCP shim command inside the container (default "marathon-mcp-shim"). */
    shimCommand?: string;
    /** Extra args before `--socket` (e.g. `["tsx", "…/bin.ts"]` in a Docker-less demo). */
    shimArgs?: string[];
    /** Model to pass to `--fallback-model` (a cheaper Anthropic model for overload). */
    fallbackModel?: string;
  };
  /** Host dir for per-task broker sockets (default the OS temp dir). */
  socketDir?: string;
  /**
   * Remaining task budget (USD) for the mid-invocation kill (§4.3). Resolved per
   * turn (the runtime is shared across tasks); when the streamed usage's estimated
   * cost exceeds it, the invocation is killed and the turn discarded (§11.2).
   */
  getRemainingBudgetUsd?: (ctx: AgentTurnContext) => Promise<number | undefined> | number | undefined;
}

/** Encoded per-turn session pointer: the Claude session id + the snapshot path (§5.2). */
export interface SessionRef {
  sessionId: string;
  /** Host path of the snapshotted JSONL for this completed turn. */
  snapshot?: string;
  /** True when the turn stopped on `--max-turns` (resume with a continuation prompt). */
  continued?: boolean;
}

export function encodeSessionRef(ref: SessionRef): string {
  return JSON.stringify(ref);
}

export function decodeSessionRef(raw: string | undefined): SessionRef | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.sessionId === "string") return v as SessionRef;
  } catch {
    /* legacy/plain refs are ignored — the run starts a fresh session */
  }
  return undefined;
}

export interface ClaudeArgvParams {
  bin: string;
  prompt: string;
  model: string;
  sessionId: string;
  /** `--resume <id>` when true, else `--session-id <id>` on the first turn (§5.2). */
  resume: boolean;
  instructions: string;
  maxTurns: number;
  /** Guest path of the MCP config (§3.1). */
  mcpConfigPath: string;
  settingsPath?: string;
  disallowedTools: string[];
  fallbackModel?: string;
  /** Belt-and-suspenders spend cap; never the enforcement (§4.3, verify-on-pin). */
  budgetUsd?: number;
}

/**
 * Build the `claude -p` argv for one harness turn (pure + exported so flags and
 * secret-freedom can be asserted without a CLI). Mirrors `claude-code-impl.md` §11.
 */
export function claudeArgv(p: ClaudeArgvParams): string[] {
  const argv = [p.bin, "-p", p.prompt];
  argv.push(p.resume ? "--resume" : "--session-id", p.sessionId);
  argv.push("--output-format", "stream-json", "--verbose");
  argv.push("--max-turns", String(p.maxTurns));
  argv.push("--model", p.model);
  if (p.fallbackModel) argv.push("--fallback-model", p.fallbackModel);
  argv.push("--append-system-prompt", p.instructions);
  argv.push("--mcp-config", p.mcpConfigPath, "--strict-mcp-config");
  argv.push("--permission-mode", "bypassPermissions");
  if (p.disallowedTools.length) argv.push("--disallowedTools", p.disallowedTools.join(","));
  if (p.settingsPath) argv.push("--settings", p.settingsPath);
  if (p.budgetUsd != null) argv.push("--max-budget-usd", String(p.budgetUsd));
  return argv;
}

/** The MCP config passed via `--mcp-config --strict-mcp-config` (§3.1). */
export function mcpConfigJson(guestSocket: string, shim: { command: string; args?: string[] }): string {
  return JSON.stringify({
    mcpServers: {
      marathon: {
        type: "stdio",
        command: shim.command,
        args: [...(shim.args ?? []), "--socket", guestSocket],
      },
    },
  });
}

/**
 * Host path of Claude's session JSONL for a container run (§5.1). `CLAUDE_CONFIG_DIR`
 * lives under the workspace home (`/workspace/.marathon-home/.claude`), which is the
 * bind-mounted workspace on the host — so the runtime snapshots/restores the file
 * directly, no `docker cp`. The `projects/<cwd-slug>/` layout is Claude's own; the
 * slug derivation is a verify-on-pin item (§10.4).
 */
export function claudeSessionHostPath(params: {
  workspaceDir: string;
  sessionId: string;
  guestConfigDir?: string;
  guestCwd?: string;
  guestWorkspace?: string;
}): string {
  const guestWorkspace = params.guestWorkspace ?? GUEST_WORKSPACE;
  const guestConfigDir = params.guestConfigDir ?? GUEST_CONFIG_DIR;
  const guestCwd = params.guestCwd ?? GUEST_WORKSPACE;
  const hostConfigDir = guestConfigDir.startsWith(guestWorkspace)
    ? join(params.workspaceDir, guestConfigDir.slice(guestWorkspace.length))
    : guestConfigDir;
  const slug = guestCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(hostConfigDir, "projects", slug, `${params.sessionId}.jsonl`);
}

const DEFAULT_MAX_TURNS = 10;

/**
 * The `--disallowedTools` list for a turn (pure + exported for tests). `Task`
 * is always denied (no sub-agent spawning); `WebFetch` under locked-down
 * egress (§3.3); and under `readOnly` the built-in file-mutating tools + shell
 * (chat-repo.md §3.4), leaving Read/Grep/Glob/LS and the governed MCP tools.
 */
export function disallowedTools(opts: { lockedDownEgress?: boolean; readOnly?: boolean }): string[] {
  return [
    "Task",
    ...(opts.lockedDownEgress ? ["WebFetch"] : []),
    ...(opts.readOnly ? ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] : []),
  ];
}

export interface ModelAccessParams {
  /** The host-side model proxy endpoint, when configured (proxy mode). */
  proxyBaseUrl?: string;
  /** The Marathon Anthropic key for direct mode; undefined in proxy mode. */
  directKey?: string;
  /** `network: none` — the container has NO egress except the proxy. */
  lockedDownEgress?: boolean;
}

/**
 * The `ANTHROPIC_*` / `CLAUDE_*` env for the CLI's model access, and the
 * decision between the two postures (design: model-proxy decision, §4.1).
 * Exported pure so the posture logic is testable without a container.
 *
 * - **Direct (the default on `network: bridge`).** A Marathon-dedicated Anthropic
 *   key is injected at launch. The sandbox already has open outbound on bridge,
 *   so a proxy would add **no data boundary** here — it would only hide the key
 *   from a *non-code-exec* leak. Treat the key as a low-blast-radius **spend**
 *   credential (budget-capped, rotated), never a business/data credential; the
 *   GitHub/Slack/document credentials stay brokered on the host regardless.
 * - **Proxy (opt-in on bridge; REQUIRED under locked-down egress).** The key
 *   never enters the container; the call exits through the host proxy, which
 *   injects the real key and is the sole allowed egress in the `network: none`
 *   posture.
 *
 * Throws when locked-down egress has no proxy (no other route to the model API),
 * or when direct mode has no key configured — fail closed either way.
 */
export function resolveModelAccessEnv(p: ModelAccessParams): Record<string, string> {
  const base: Record<string, string> = {
    CLAUDE_CONFIG_DIR: GUEST_CONFIG_DIR,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (p.proxyBaseUrl) {
    return { ...base, ANTHROPIC_BASE_URL: p.proxyBaseUrl, ANTHROPIC_API_KEY: "marathon-proxy" };
  }
  if (p.lockedDownEgress) {
    throw new Error(
      "claude-code under locked-down egress (network: none) requires the model proxy — the container has no other route to the model API (§4.1)",
    );
  }
  if (!p.directKey) {
    throw new Error(
      "claude-code (direct model access) needs a Marathon Anthropic key in the secret store (secret/anthropic); none found",
    );
  }
  return { ...base, ANTHROPIC_API_KEY: p.directKey };
}

export class ClaudeCodeAgentRuntime implements AgentRuntime {
  constructor(private readonly opts: ClaudeCodeAgentOptions) {}

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    const { provider, model } = parseModelRef(ctx.request.modelRef);
    if (provider !== "anthropic") {
      throw new Error(
        `claude-code harness requires an Anthropic model; got provider "${provider}" (§13.1 — harness pins provider)`,
      );
    }
    const registry = this.opts.registry ?? new ModelRegistry();
    const spec = registry.get(ctx.request.modelRef);
    const maxTurns = this.opts.maxTurnsPerInvocation ?? DEFAULT_MAX_TURNS;

    const workspace = ctx.workspace;
    if (!workspace) {
      throw new Error("claude-code harness requires a code workspace binding (§29.2)");
    }

    // Model access (§4.1, model-proxy decision): DIRECT key injection is the
    // default on `network: bridge` (the sandbox already has open outbound, so a
    // proxy adds no data boundary — see resolveModelAccessEnv); the proxy is
    // opt-in there and REQUIRED under locked-down egress. Resolve a direct key
    // only when no proxy is wired, and build the env NOW — BEFORE any resource
    // (session restore, broker socket, container) is provisioned — so a
    // misconfiguration fails closed without leaking a broker or container.
    const proxyBaseUrl = this.opts.proxy?.baseUrl;
    const directKey = proxyBaseUrl ? undefined : await resolveApiKey(this.opts.secrets, provider);
    const modelAccessEnv = resolveModelAccessEnv({
      proxyBaseUrl,
      directKey,
      lockedDownEgress: this.opts.lockedDownEgress,
    });

    // Resume vs first turn (§5.2): a decoded session ref carries the Claude
    // session id and the snapshot to restore over any partial JSONL.
    const prior = decodeSessionRef(ctx.checkpoint.sessionRef);
    const resume = !!(prior?.snapshot && existsSync(prior.snapshot));
    const sessionId = resume ? prior!.sessionId : newId();

    const sessionHostPath = claudeSessionHostPath({ workspaceDir: workspace.dir, sessionId });
    if (resume) {
      // Restore the snapshot OVER whatever a crashed invocation left behind
      // (§5.2: "discard the incomplete turn and replay").
      mkdirSync(dirname(sessionHostPath), { recursive: true });
      copyFileSync(prior!.snapshot!, sessionHostPath);
    }

    // Per-task broker socket (§3.1): host-side unix socket, mounted into the
    // container, serving governed tools through the gateway.
    const socketDir = this.opts.socketDir ?? join(process.cwd(), ".marathon-sockets");
    mkdirSync(socketDir, { recursive: true });
    const hostSocket = join(socketDir, `${ctx.request.taskId}-${sessionId.slice(0, 8)}.sock`);
    const question: { value?: string } = {};
    const broker = this.startBroker(hostSocket, ctx, (q) => {
      question.value = q;
    });

    // Everything after the broker starts is inside the try/finally, so a
    // failure in workspace/MCP setup, container creation, or start still closes
    // the broker (and stops a started container) — no leaked socket/server.
    let container: AgentContainer | undefined;
    const start = Date.now();
    try {
      // MCP config into the workspace home (host-visible → readable in-container).
      const mcpHostPath = join(workspace.dir, ".marathon-home", "mcp.json");
      mkdirSync(dirname(mcpHostPath), { recursive: true });
      writeFileSync(
        mcpHostPath,
        mcpConfigJson(GUEST_BROKER_SOCKET, {
          command: this.opts.cli?.shimCommand ?? "marathon-mcp-shim",
          args: this.opts.cli?.shimArgs,
        }),
      );

      container = await this.opts.sandbox.createContainer(ctx.request, workspace, {
        mounts: [{ source: hostSocket, target: GUEST_BROKER_SOCKET }],
      });
      await container.start();

      // A run that stopped on --max-turns resumes with a neutral continuation
      // prompt; a normal resume (e.g. a durable-wait answer) uses the given input.
      const prompt = resume && prior?.continued ? CONTINUATION_PROMPT : ctx.request.input;
      const disallowed = disallowedTools({
        lockedDownEgress: this.opts.lockedDownEgress,
        readOnly: this.opts.readOnly,
      });
      const argv = claudeArgv({
        bin: this.opts.cli?.bin ?? "claude",
        prompt,
        model,
        sessionId,
        resume,
        instructions: ctx.request.instructions,
        maxTurns,
        mcpConfigPath: GUEST_MCP_CONFIG,
        settingsPath: this.opts.cli?.settingsPath,
        disallowedTools: disallowed,
        fallbackModel: this.opts.cli?.fallbackModel,
      });

      const acc = new ClaudeStreamAccumulator();
      const remainingBudget = await this.opts.getRemainingBudgetUsd?.(ctx);
      const abort = new AbortController();
      let budgetKilled = false;
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ev = parseStreamJsonLine(line);
          if (!ev) continue;
          acc.push(ev, ctx.onEvent);
          // Mid-invocation budget kill (§4.3): between-turn checks can't stop a
          // runaway single invocation.
          if (remainingBudget != null && !budgetKilled && acc.estimatedCostUsd(spec) > remainingBudget) {
            budgetKilled = true;
            abort.abort();
          }
        }
      };

      const env = modelAccessEnv;

      let exitCode: number | null = null;
      try {
        const r = await container.execStream(argv, { onData, env, cwd: GUEST_WORKSPACE, signal: abort.signal });
        exitCode = r.exitCode;
      } catch (err) {
        if (budgetKilled) {
          throw new Error(
            `task budget exceeded mid-invocation — killed (~$${acc.estimatedCostUsd(spec).toFixed(4)} > $${remainingBudget})`,
          );
        }
        throw err;
      }

      const decision = interpretResult(acc.result);
      if (decision.error) {
        throw new Error(`${decision.error}${exitCode != null ? ` (exit ${exitCode})` : ""}`);
      }

      // Snapshot the session JSONL at the turn boundary (§5.2): the snapshot IS
      // the resume point. Anything a later crashed invocation appends is discarded.
      const taskSessionDir = this.opts.sessionDir ? join(this.opts.sessionDir, ctx.request.taskId) : undefined;
      const turnIndex = (ctx.checkpoint.turnIndex ?? -1) + 1;
      let snapshot: string | undefined;
      if (taskSessionDir && existsSync(sessionHostPath)) {
        mkdirSync(taskSessionDir, { recursive: true });
        snapshot = join(taskSessionDir, `turn-${turnIndex}.jsonl`);
        copyFileSync(sessionHostPath, snapshot);
      }

      const modelInvocation = resultInvocation(acc, provider, model, Date.now() - start);
      const sessionRef = encodeSessionRef({ sessionId, snapshot, continued: decision.continued });

      ctx.onEvent?.({ type: "turn_end", summary: `turn ${turnIndex} complete` });
      if (ctx.onTurnCheckpoint) {
        await ctx.onTurnCheckpoint({ turnIndex, sessionRef, modelInvocation });
      }

      // A captured clarifying question turns the run into a durable wait (§2.3).
      const done = decision.done && question.value === undefined;
      return {
        text: acc.finalText(),
        done,
        waiting: question.value !== undefined ? { question: question.value } : undefined,
        sessionRef,
        turnIndex,
        // Usage is accounted per-turn via the checkpoint sink; avoid double-count.
        modelInvocation: ctx.onTurnCheckpoint ? undefined : modelInvocation,
      };
    } finally {
      broker.close();
      await container?.stop().catch(() => {});
    }
  }

  private startBroker(
    hostSocket: string,
    ctx: AgentTurnContext,
    onAskUser: (question: string) => void,
  ): { close: () => void } {
    // Fresh socket each turn (containers are never recovered, §11.2).
    if (existsSync(hostSocket)) {
      try {
        rmSync(hostSocket);
      } catch {
        /* ignore */
      }
    }
    const gateway = this.opts.governed?.gateway as ToolGateway | undefined;
    const specs = this.opts.governed?.tools ?? [];
    const govCtx = {
      taskId: ctx.request.taskId,
      tenantId: ctx.request.tenantId ?? "",
      agentId: ctx.request.agentId,
    };
    const conns: Socket[] = [];
    let server: Server | undefined;
    if (gateway) {
      server = createServer((conn) => {
        conns.push(conn);
        serveToolBroker(conn, conn, gateway, govCtx, {
          tools: specs,
          onAskUser: this.opts.clarification ? onAskUser : undefined,
        });
      });
      server.listen(hostSocket);
    }
    return {
      close: () => {
        for (const c of conns) c.destroy();
        server?.close();
        if (existsSync(hostSocket)) {
          try {
            rmSync(hostSocket);
          } catch {
            /* ignore */
          }
        }
      },
    };
  }
}

function resultInvocation(
  acc: ClaudeStreamAccumulator,
  provider: string,
  model: string,
  latencyMs: number,
): ModelInvocationData {
  const usage = acc.result?.usage;
  return {
    provider,
    model,
    inputTokens: usage?.input_tokens ?? acc.usage.input,
    outputTokens: usage?.output_tokens ?? acc.usage.output,
    costUsd: acc.result?.total_cost_usd ?? null,
    latencyMs: acc.result?.duration_api_ms ?? latencyMs,
    status: acc.result?.is_error ? "error" : "ok",
  };
}
