import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, redactSecrets } from "@marathon/core";
import type { SecretStore } from "@marathon/config";
import { ModelRegistry, parseModelRef } from "@marathon/model-gateway";
import { type ContainerMount, serveToolBroker, type ToolGateway } from "@marathon/tools";
import type { GovernedToolsConfig } from "./pi";
import { type AgentContainer, decodeSessionRef, encodeSessionRef, GUEST_BROKER_SOCKET } from "./claude-code";
import { CodexStreamAccumulator, interpretResult, parseStreamJsonLine } from "./codex-stream";
import type {
  AgentRequest,
  AgentRuntime,
  AgentTurn,
  AgentTurnContext,
  AgentWorkspaceBinding,
  ModelInvocationData,
} from "./types";

/**
 * Real Codex CLI (headless) harness adapter — the third `AgentRuntime` behind
 * the seam (design §7.5, roadmap K8; full reference in `codex-cli-impl.md`),
 * sibling of the Pi and Claude Code runtimes.
 *
 * One harness turn = one `codex exec --json` invocation inside the task's
 * hardened container (Pattern 1, §12.6): the agent loop runs *in* the sandbox,
 * its shell/file tools are contained by construction (they see only
 * `/workspace`), governed tools are brokered back to the host over a per-task
 * unix socket (or token-guarded TCP) via the SAME `marathon-mcp-shim` Claude
 * Code uses, and the model call exits only through host-controlled OpenAI auth.
 * The session/rollout state under `CODEX_HOME` is snapshotted per completed
 * invocation and resumed with `codex exec resume <sid>` (§5.2).
 *
 * The one step Claude Code doesn't have: an ATOMIC per-turn rewrite of
 * `$CODEX_HOME/config.toml` (config only — the resumable session state lives in
 * the same tree, so a whole-tree rewrite would destroy resume state, §3.1).
 */

// AgentContainer is defined in claude-code.ts (the shared subprocess-harness
// container seam) and imported above.

/** Guest-side conventions inside the container (codex-cli-impl.md §5.1). */
const GUEST_WORKSPACE = "/workspace";
/** HOME is already `/workspace/.marathon-home` in the image; CODEX_HOME hangs off it (§5.1). */
export const GUEST_HOME = "/workspace/.marathon-home";
export const GUEST_CODEX_HOME = "/workspace/.marathon-home/.codex";
export { GUEST_BROKER_SOCKET };

/**
 * Subpath under `$CODEX_HOME` holding the resumable session/rollout state (§5.2).
 * The exact on-disk layout is a verify-on-pin item (§10 #7): implemented as a
 * configurable subtree so the pin-time correction is a one-line default change.
 * The whole subtree is snapshotted/restored (directory copy) so whatever Codex
 * writes there is captured wholesale.
 */
export const DEFAULT_SESSIONS_SUBDIR = "sessions";

export interface CodexAgentOptions {
  /**
   * Host-side secret store. In **direct mode** (the bridge default, §4.1) the
   * Marathon-dedicated OpenAI key (`secret/openai-codex`, a separate spend-capped
   * credential) is injected into the container as `CODEX_API_KEY`. Business
   * credentials (GitHub/Slack/document) never enter the sandbox in any mode.
   */
  secrets: SecretStore;
  registry?: ModelRegistry;
  /** Per-task session snapshots (§5.2). */
  sessionDir?: string;
  /** REQUIRED — this harness runs the whole loop inside a container. */
  sandbox: {
    createContainer: (
      req: AgentRequest,
      workspace: AgentWorkspaceBinding | undefined,
      extra?: { mounts?: ContainerMount[]; extraHosts?: string[] },
    ) => Promise<AgentContainer> | AgentContainer;
  };
  /** Governed tools, served via broker + MCP shim (same spec list as Pi/Claude Code, §3.1). */
  governed?: GovernedToolsConfig;
  /** Expose `ask_user` over MCP (§2.3). */
  clarification?: boolean;
  /**
   * `network: none` — the container has NO egress to OpenAI. Fails closed until
   * the OpenAI key-injecting proxy component exists (§4.1); no proxy option is
   * offered because none is built.
   */
  lockedDownEgress?: boolean;
  /**
   * Reach the governed-tool broker over **TCP** at this host instead of a
   * bind-mounted unix socket (§3.1). Set to `"host.docker.internal"` for **macOS
   * Docker Desktop**, where a mounted unix socket is not connectable across the
   * host↔VM boundary (ENOTSUP). Unset → the unix socket (the Linux default).
   */
  brokerHost?: string;
  /**
   * Read-only tool surface (chat follow-on, §3.3): maps to `--sandbox read-only`
   * so the CLI's own defense-in-depth sandbox forbids file mutation. The `:ro`
   * workspace mount and the gateway remain the real boundary.
   */
  readOnly?: boolean;
  /**
   * Optional Marathon-side wall-clock watchdog (§2.1): SIGTERM/kill a runaway
   * invocation past this budget and fail the turn under the §11.2 mid-turn rule
   * (no checkpoint of partial state — the turn reruns from the last snapshot).
   */
  maxWallClockMsPerInvocation?: number;
  cli?: {
    /** The `codex` binary inside the container (default "codex"; a fake stub via demos). */
    bin?: string;
    /** The MCP shim command inside the container (default "marathon-mcp-shim"). */
    shimCommand?: string;
    /** Extra args before `--socket`/`--tcp` (e.g. `["tsx", "…/bin.ts"]` in a Docker-less demo). */
    shimArgs?: string[];
  };
  /** Host dir for per-task broker sockets (default the OS temp dir). */
  socketDir?: string;
  /** Subpath under `$CODEX_HOME` holding session state (§5.2 verify-on-pin #7; default "sessions"). */
  sessionsSubdir?: string;
  /**
   * Subscription mode (§4.1, DEV-ONLY): host path of a ChatGPT-login
   * `auth.json` (typically `~/.codex/auth.json`), wired from
   * {@link AUTH_JSON_ENV} by the entrypoints. When set, the runtime stages the
   * file to `$CODEX_HOME/auth.json` per turn ({@link stageSubscriptionAuthJson})
   * and injects NO `CODEX_API_KEY`. Requires {@link SUBSCRIPTION_ACK_ENV}=1 —
   * the credential lands on the host-visible workspace mount, readable by
   * agent code in the container. Takes precedence over the direct key.
   */
  subscriptionAuthJsonPath?: string;
  /**
   * Remaining task budget (USD) for the mid-invocation kill (§4.3). ONLY
   * effective when the stream carries usage BEFORE `turn.completed` (unconfirmed,
   * verify-on-pin #2): the hook engages when per-event usage is present and is a
   * no-op otherwise; between-turn checks + the wall-clock watchdog are the
   * interim bound when the stream lacks mid-turn usage.
   */
  getRemainingBudgetUsd?: (ctx: AgentTurnContext) => Promise<number | undefined> | number | undefined;
}

/** Secret ref for the Marathon-dedicated OpenAI *spend* key (§4.1) — separate from the model-gateway key. */
export const CODEX_API_KEY_SECRET = "secret/openai-codex";

/**
 * Env var naming the host path of a ChatGPT-login `auth.json` for subscription
 * mode (§4.1, dev-only; typically `~/.codex/auth.json` from `codex login`).
 * The file IS the credential — the CLI reads `$CODEX_HOME/auth.json`, so the
 * runtime copies it into the task's `CODEX_HOME` per turn (never into env,
 * argv, config.toml, logs, or session snapshots).
 */
export const AUTH_JSON_ENV = "MARATHON_CODEX_AUTH_JSON";

/** Env var that acknowledges the dev-only risk of ChatGPT-subscription auth (§4.1). */
export const SUBSCRIPTION_ACK_ENV = "MARATHON_CODEX_SUBSCRIPTION_DEV";

/**
 * Fail closed on subscription mode unless explicitly acknowledged as dev-only
 * (§4.1). The `auth.json` is a high-value **personal** credential, and
 * subscription mode COPIES it onto the host-visible workspace mount
 * (`$CODEX_HOME/auth.json`), readable by arbitrary agent code in the container
 * on bridge — confirmed persistence, not a maybe (verify-on-pin #4 resolved).
 * So subscription mode must not activate silently beyond local dev.
 * Direct-key mode is unaffected. Exported pure for tests. Mirrors
 * `assertSubscriptionAckIfNeeded` (claude-code.ts).
 */
export function assertSubscriptionAckIfNeeded(
  authJsonPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (authJsonPath && env[SUBSCRIPTION_ACK_ENV] !== "1") {
    throw new Error(
      `codex ChatGPT-subscription auth is DEV-ONLY: the auth.json is a personal credential, and subscription mode ` +
        `copies it into CODEX_HOME on the host-visible workspace, readable by code in the sandbox on bridge (§4.1). ` +
        `Set ${SUBSCRIPTION_ACK_ENV}=1 to acknowledge and proceed, or use a CODEX_API_KEY (secret/openai-codex).`,
    );
  }
}

/**
 * Stage the ChatGPT-login credential for subscription mode (§4.1): copy the
 * host `auth.json` to `$CODEX_HOME/auth.json` (mode 0600) where the CLI reads
 * it. The contents are never read into logs/argv/config, never enter env, and
 * live only on the ephemeral workspace (destroyed at teardown, excluded from
 * the repo's git view, and OUTSIDE the sessions subtree so a per-turn snapshot
 * can never capture it — asserted by test). Throws fail-closed when the
 * configured file is missing/unreadable, BEFORE any resource is provisioned.
 */
export function stageSubscriptionAuthJson(params: {
  workspaceDir: string;
  authJsonPath: string;
  guestCodexHome?: string;
  guestWorkspace?: string;
}): string {
  let contents: Buffer;
  try {
    contents = readFileSync(params.authJsonPath);
  } catch (e) {
    throw new Error(
      `codex subscription mode is configured (${AUTH_JSON_ENV}) but the auth.json is unreadable: ${params.authJsonPath} — ` +
        `run \`codex login\` on the host or point ${AUTH_JSON_ENV} at a valid file (§4.1): ${(e as Error).message}`,
    );
  }
  const home = codexHomeHostPath(params);
  mkdirSync(home, { recursive: true });
  const dest = join(home, "auth.json");
  writeFileSync(dest, contents, { mode: 0o600 });
  return dest;
}

export interface CodexArgvParams {
  bin: string;
  prompt: string;
  model: string;
  /** The Codex session id to resume; undefined on the first turn (id is minted via thread.started, §2.2). */
  resumeSessionId?: string;
  /** `--sandbox read-only` when true, else `workspace-write` (§3.3). */
  readOnly?: boolean;
}

/**
 * Build the `codex exec` argv for one harness turn (pure + exported so flags and
 * secret-freedom can be asserted without a CLI). Mirrors codex-cli-impl.md §11.
 *
 * First turn:   `codex exec --json "<prompt>" --sandbox … --ask-for-approval never --model … --cd /workspace`
 * Resume (§2.1): `codex exec --json resume <sid> "<prompt>" …` — `resume <sid>`
 * is a subcommand right after `exec`, the prompt after it. Never `--ephemeral`
 * (it would disable the durable session persistence resume depends on, §5.2).
 * NO secrets ever appear in argv (§4.1 — the key rides the container env).
 */
export function codexArgv(p: CodexArgvParams): string[] {
  const argv = [p.bin, "exec", "--json"];
  if (p.resumeSessionId) argv.push("resume", p.resumeSessionId);
  argv.push(p.prompt);
  argv.push("--sandbox", p.readOnly ? "read-only" : "workspace-write");
  // Headless runs can't answer approval prompts; the Marathon MCP server is
  // pre-approved in config.toml (§3.3). No `--yolo` on the happy path.
  argv.push("--ask-for-approval", "never");
  argv.push("--model", p.model);
  argv.push("--cd", GUEST_WORKSPACE);
  return argv;
}

/** TOML basic-string escape (§3.1): backslash, quote, and control chars per the TOML spec. */
function tomlBasicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export interface CodexConfigTomlParams {
  /** The MCP shim command inside the container (default "marathon-mcp-shim"). */
  shimCommand: string;
  /** Extra args before the transport args (e.g. a `tsx` launcher in a Docker-less demo). */
  shimArgs?: string[];
  /** Broker transport: a guest unix-socket path, or a TCP `host:port`. */
  connect: { socket: string } | { tcp: string };
  /** The per-turn capability token the shim must present (§3.1). */
  token?: string;
  /** The agent persona (AgentRequest.instructions) → `developer_instructions` (§2.4). */
  instructions: string;
}

/**
 * Render `$CODEX_HOME/config.toml` (codex-cli-impl.md §3.1). Pure + exported so
 * the governed-MCP wiring, the untrusted-project pin, and the persona escaping
 * can be asserted without a CLI. The runtime writes this ATOMICALLY and touches
 * ONLY config.toml — never the session state beside it (§3.1).
 *
 *   [mcp_servers.marathon]  — the governed-tool broker, `required = true` so a
 *     wedged/absent shim FAILS the invocation (never a governed-tool-less run,
 *     §4.2); `startup_timeout_sec` bounds the handshake; the marathon server is
 *     pre-approved (`default_tools_approval_mode = "approve"`, §3.3).
 *   developer_instructions  — the persona, APPENDED to Codex's built-in system
 *     prompt (the `--append-system-prompt` analog, §2.4).
 *   [projects."/workspace"] trust_level = "untrusted" — pin the workspace
 *     untrusted so no repo-local `.codex/` layer (config/hooks/rules) is ever
 *     loaded from the checkout (§3.1).
 */
export function codexConfigToml(p: CodexConfigTomlParams): string {
  const connectArgs =
    "socket" in p.connect ? ["--socket", p.connect.socket] : ["--tcp", p.connect.tcp];
  if (p.token) connectArgs.push("--token", p.token);
  const args = [...(p.shimArgs ?? []), ...connectArgs];
  const argsToml = `[${args.map(tomlBasicString).join(", ")}]`;
  // Top-level keys FIRST: in TOML a bare `key = value` after a table header
  // belongs to that table, so `developer_instructions` must precede
  // `[mcp_servers.marathon]` to stay top-level (§2.4).
  return (
    `developer_instructions = ${tomlBasicString(p.instructions)}\n` +
    `\n` +
    `[mcp_servers.marathon]\n` +
    `command = ${tomlBasicString(p.shimCommand)}\n` +
    `args = ${argsToml}\n` +
    `default_tools_approval_mode = "approve"\n` +
    `required = true\n` +
    `startup_timeout_sec = 20\n` +
    `\n` +
    `[projects."/workspace"]\n` +
    `trust_level = "untrusted"\n`
  );
}

/**
 * Host path of `$CODEX_HOME` for a container run (§5.1). `CODEX_HOME` lives under
 * the workspace home (`/workspace/.marathon-home/.codex`), which is the
 * bind-mounted workspace on the host — so the runtime snapshots/restores state
 * directly, no `docker cp` (analog of `claudeSessionHostPath`).
 */
export function codexHomeHostPath(params: { workspaceDir: string; guestCodexHome?: string; guestWorkspace?: string }): string {
  const guestWorkspace = params.guestWorkspace ?? GUEST_WORKSPACE;
  const guestCodexHome = params.guestCodexHome ?? GUEST_CODEX_HOME;
  return guestCodexHome.startsWith(guestWorkspace)
    ? join(params.workspaceDir, guestCodexHome.slice(guestWorkspace.length))
    : guestCodexHome;
}

/**
 * Host path of the session-state subtree under `$CODEX_HOME` (§5.2). The whole
 * subtree is snapshotted/restored (directory copy) since the exact layout is a
 * verify-on-pin item (§10 #7).
 */
export function codexSessionHostPath(params: {
  workspaceDir: string;
  sessionsSubdir?: string;
  guestCodexHome?: string;
  guestWorkspace?: string;
}): string {
  return join(
    codexHomeHostPath(params),
    params.sessionsSubdir ?? DEFAULT_SESSIONS_SUBDIR,
  );
}

/** Host path of the config.toml under `$CODEX_HOME` (§3.1). */
export function codexConfigHostPath(params: { workspaceDir: string; guestCodexHome?: string; guestWorkspace?: string }): string {
  return join(codexHomeHostPath(params), "config.toml");
}

/**
 * Write `config.toml` ATOMICALLY (temp file + rename) so a crashed/tampered
 * previous config never leaks in, and so the write NEVER touches the session
 * state beside it (§3.1). The rename is within the same dir (same filesystem).
 * Exported for the atomic-write test.
 */
export function writeCodexConfigAtomic(configPath: string, contents: string): void {
  mkdirSync(join(configPath, ".."), { recursive: true });
  const tmp = `${configPath}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, configPath);
}

export interface CodexModelAccessParams {
  /** The Marathon-dedicated OpenAI spend key for direct mode; undefined otherwise. */
  directKey?: string;
  /** Subscription mode (dev-only): an auth.json is staged into `$CODEX_HOME` (§4.1). */
  subscription?: boolean;
  /** `network: none` — the container has NO egress (no OpenAI proxy exists yet). */
  lockedDownEgress?: boolean;
}

/**
 * The `CODEX_*` env for the CLI's model access and the posture decision
 * (codex-cli-impl.md §4.1). Exported pure so the posture logic is testable
 * without a container. Mirrors `resolveModelAccessEnv` (claude-code.ts).
 *
 * - **Direct API key (the default on `network: bridge`).** The Marathon
 *   spend-capped OpenAI key is injected as `CODEX_API_KEY`, billed per token.
 * - **Subscription (bridge, dev-only, opt-in).** The credential is the
 *   `auth.json` FILE the CLI reads from `$CODEX_HOME` — staged by
 *   `stageSubscriptionAuthJson`, NOT carried in env. NO `CODEX_API_KEY` is set
 *   (an API key would override the login and force per-token billing).
 *   Gated by `assertSubscriptionAckIfNeeded` at the runtime boundary.
 * - **Locked-down egress → THROW.** No OpenAI proxy component exists yet (§4.1),
 *   so `network: none` has no route to the model API — fail closed.
 *
 * Precedence: subscription › direct API key. Business credentials stay brokered
 * on the host in every mode. Throws under locked-down egress, or when no model
 * credential is configured.
 */
export function resolveCodexModelAccessEnv(p: CodexModelAccessParams): Record<string, string> {
  if (p.lockedDownEgress) {
    throw new Error(
      "codex under locked-down egress (network: none) has no route to the OpenAI API — the key-injecting proxy component is not built yet (codex-cli-impl.md §4.1); use 'bridge'",
    );
  }
  const base: Record<string, string> = {
    CODEX_HOME: GUEST_CODEX_HOME,
    HOME: GUEST_HOME,
  };
  if (p.subscription) {
    // Subscription: the credential is a file under $CODEX_HOME, not env — and
    // NO CODEX_API_KEY (an API key would win and force per-token billing).
    return base;
  }
  if (!p.directKey) {
    throw new Error(
      "codex needs a model credential: a Marathon OpenAI key (secret/openai-codex) for API billing, " +
        `or a ChatGPT-login auth.json (${AUTH_JSON_ENV}=<path>, dev-only); none found (§4.1)`,
    );
  }
  return { ...base, CODEX_API_KEY: p.directKey };
}

export class CodexAgentRuntime implements AgentRuntime {
  constructor(private readonly opts: CodexAgentOptions) {}

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    const { provider, model } = parseModelRef(ctx.request.modelRef);
    if (provider !== "openai") {
      throw new Error(
        `codex harness requires an OpenAI model; got provider "${provider}" (§13.1 — harness pins provider)`,
      );
    }
    const registry = this.opts.registry ?? new ModelRegistry();
    const spec = registry.get(ctx.request.modelRef);

    const workspace = ctx.workspace;
    if (!workspace) {
      throw new Error("codex harness requires a code workspace binding (§29.2)");
    }

    // Model access (§4.1): resolve the credential and build the env NOW — BEFORE
    // any resource (session restore, broker socket, container) is provisioned —
    // so a misconfiguration fails closed without leaking a broker or container.
    // Precedence: subscription (auth.json) › direct API key.
    const authJsonPath = this.opts.subscriptionAuthJsonPath;
    assertSubscriptionAckIfNeeded(authJsonPath);
    const directKey = authJsonPath ? undefined : await this.opts.secrets.get(CODEX_API_KEY_SECRET);
    const subscription = authJsonPath != null;
    const modelAccessEnv = resolveCodexModelAccessEnv({
      directKey,
      subscription,
      lockedDownEgress: this.opts.lockedDownEgress,
    });
    if (authJsonPath) {
      // Stage the login credential where the CLI reads it ($CODEX_HOME/auth.json,
      // mode 0600). Reads the host file here — still before provisioning — so a
      // missing/unreadable auth.json fails closed with no leaked broker/container.
      // The file sits OUTSIDE the sessions subtree, so snapshots never capture it.
      stageSubscriptionAuthJson({ workspaceDir: workspace.dir, authJsonPath });
    }

    // Resume vs first turn (§5.2): a decoded session ref carries the Codex
    // session id and the snapshot subtree to restore over any partial state.
    const prior = decodeSessionRef(ctx.checkpoint.sessionRef);
    const resume = !!(prior?.snapshot && existsSync(prior.snapshot));

    const sessionsHostPath = codexSessionHostPath({
      workspaceDir: workspace.dir,
      sessionsSubdir: this.opts.sessionsSubdir,
    });
    if (resume) {
      // Restore the snapshot subtree OVER whatever a crashed invocation left
      // behind (§5.2: "discard the incomplete turn and replay"). Clear first so
      // stale files that aren't in the snapshot don't survive.
      rmSync(sessionsHostPath, { recursive: true, force: true });
      mkdirSync(join(sessionsHostPath, ".."), { recursive: true });
      cpSync(prior!.snapshot!, sessionsHostPath, { recursive: true });
    }

    // Per-task broker transport (§3.1). Default: a host-side **unix socket**
    // bind-mounted into the container. On **macOS Docker Desktop** a bind-mounted
    // socket is not connectable (ENOTSUP), so when `brokerHost` is set the broker
    // listens on **TCP** and the container connects to `<brokerHost>:<port>`.
    const tcpBroker = this.opts.brokerHost !== undefined;
    const question: { value?: string } = {};
    let hostSocket: string | undefined;
    let broker: { close: () => void; port?: number; token: string };
    if (tcpBroker) {
      broker = await this.startBroker({ tcp: true }, ctx, (q) => (question.value = q));
    } else {
      const socketDir = this.opts.socketDir ?? join(tmpdir(), "mar");
      mkdirSync(socketDir, { recursive: true });
      const socketId = createHash("sha1")
        .update(`${ctx.request.taskId}:${prior?.sessionId ?? newId()}`)
        .digest("hex")
        .slice(0, 16);
      hostSocket = join(socketDir, `${socketId}.sock`);
      if (hostSocket.length > 103) {
        throw new Error(
          `broker socket path is too long for a unix domain socket (${hostSocket.length} > 103): ${hostSocket} — set a shorter socketDir, or use TCP (brokerHost)`,
        );
      }
      broker = await this.startBroker({ unixSocket: hostSocket }, ctx, (q) => (question.value = q));
    }

    // Everything after the broker starts is inside the try/finally, so a failure
    // in config/container setup still closes the broker (and stops a started
    // container) — no leaked socket/server.
    let container: AgentContainer | undefined;
    const start = Date.now();
    try {
      // Atomically rewrite `$CODEX_HOME/config.toml` per turn (§3.1) — config
      // ONLY, never the session state beside it (a whole-tree rewrite would
      // delete the very state `codex exec resume` needs).
      writeCodexConfigAtomic(
        codexConfigHostPath({ workspaceDir: workspace.dir }),
        codexConfigToml({
          shimCommand: this.opts.cli?.shimCommand ?? "marathon-mcp-shim",
          shimArgs: this.opts.cli?.shimArgs,
          connect: tcpBroker
            ? { tcp: `${this.opts.brokerHost}:${broker.port}` }
            : { socket: GUEST_BROKER_SOCKET },
          token: broker.token,
          instructions: ctx.request.instructions,
        }),
      );

      container = await this.opts.sandbox.createContainer(ctx.request, workspace, {
        mounts: hostSocket ? [{ source: hostSocket, target: GUEST_BROKER_SOCKET }] : [],
        extraHosts: tcpBroker ? ["host.docker.internal:host-gateway"] : undefined,
      });
      await container.start();

      const argv = codexArgv({
        bin: this.opts.cli?.bin ?? "codex",
        prompt: ctx.request.input,
        model,
        resumeSessionId: resume ? prior!.sessionId : undefined,
        readOnly: this.opts.readOnly,
      });

      const acc = new CodexStreamAccumulator();
      // Mid-invocation budget kill (§4.3): only effective when the stream
      // carries usage before turn.completed (verify-on-pin #2). Under
      // subscription there is no per-token dollar cost, so the USD budget is
      // inert — skip it (mirrors K7). The wall-clock watchdog (below) bounds
      // runaways regardless.
      const remainingBudget = subscription ? undefined : await this.opts.getRemainingBudgetUsd?.(ctx);
      const abort = new AbortController();
      let budgetKilled = false;
      let watchdogFired = false;
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
          // The hook engages ONLY when per-event usage was actually observed
          // before the terminal event (§4.3); otherwise it never fires and the
          // watchdog + between-turn checks are the bound.
          if (
            remainingBudget != null &&
            !budgetKilled &&
            acc.sawUsageBeforeTerminal &&
            acc.estimatedCostUsd(spec) > remainingBudget
          ) {
            budgetKilled = true;
            abort.abort();
          }
        }
      };

      // Optional wall-clock watchdog (§2.1): SIGTERM/kill a runaway past the
      // budget and fail the turn under the §11.2 mid-turn rule (no checkpoint of
      // partial state — the turn reruns from the last snapshot).
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      if (this.opts.maxWallClockMsPerInvocation != null) {
        watchdog = setTimeout(() => {
          watchdogFired = true;
          abort.abort();
        }, this.opts.maxWallClockMsPerInvocation);
      }

      let exitCode: number | null = null;
      let stderrText = "";
      let stdoutTail = "";
      try {
        const r = await container.execStream(argv, {
          onData,
          env: modelAccessEnv,
          cwd: GUEST_WORKSPACE,
          signal: abort.signal,
        });
        exitCode = r.exitCode;
        // Keep the CLI's own output so a failed run reports WHY. Redact + cap:
        // the key is in the env and the CLI could echo it in an auth error.
        stderrText = redactSecrets(r.stderr.toString("utf8"), { enabled: true }).trim();
        stdoutTail = redactSecrets(r.stdout.toString("utf8"), { enabled: true }).trim();
      } catch (err) {
        if (budgetKilled) {
          throw new Error(
            `task budget exceeded mid-invocation — killed (~$${acc.estimatedCostUsd(spec).toFixed(4)} > $${remainingBudget})`,
          );
        }
        if (watchdogFired) {
          // Mid-turn discard (§2.1/§11.2): turn fails, no snapshot of partial state.
          throw new Error(
            `codex invocation exceeded the wall-clock budget (${this.opts.maxWallClockMsPerInvocation}ms) — killed and discarded (§2.1)`,
          );
        }
        throw err;
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }

      const decision = interpretResult(acc);
      if (decision.error) {
        const cap = (s: string) => (s.length > 1500 ? `…${s.slice(-1500)}` : s);
        const diag = [
          stderrText && `stderr: ${cap(stderrText)}`,
          // Only show stdout when the CLI emitted no terminal event.
          !acc.terminal && stdoutTail && `stdout: ${cap(stdoutTail)}`,
        ]
          .filter(Boolean)
          .join("\n");
        throw new Error(`${decision.error}${exitCode != null ? ` (exit ${exitCode})` : ""}${diag ? `\n${diag}` : ""}`);
      }

      // The session id is minted by the CLI and reported via thread.started
      // (§2.2). A completed turn WITHOUT one means we can't resume — treat it as
      // a failure (interpretResult already guards the no-terminal case; this
      // guards a completed-but-idless stream).
      const sessionId = acc.sessionId;
      if (!sessionId) {
        throw new Error("codex turn completed but reported no session id (no thread.started) — cannot checkpoint/resume (§2.2)");
      }

      // Snapshot the session subtree at the turn boundary (§5.2): the snapshot IS
      // the resume point. Anything a later crashed invocation writes is discarded.
      const taskSessionDir = this.opts.sessionDir ? join(this.opts.sessionDir, ctx.request.taskId) : undefined;
      const turnIndex = (ctx.checkpoint.turnIndex ?? -1) + 1;
      let snapshot: string | undefined;
      if (taskSessionDir && existsSync(sessionsHostPath)) {
        mkdirSync(taskSessionDir, { recursive: true });
        snapshot = join(taskSessionDir, `turn-${turnIndex}`);
        rmSync(snapshot, { recursive: true, force: true });
        cpSync(sessionsHostPath, snapshot, { recursive: true });
      }

      const modelInvocation = resultInvocation(acc, provider, model, Date.now() - start, subscription, spec);
      const sessionRef = encodeSessionRef({ sessionId, snapshot });

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

  private async startBroker(
    listen: { unixSocket: string } | { tcp: true },
    ctx: AgentTurnContext,
    onAskUser: (question: string) => void,
  ): Promise<{ close: () => void; port?: number; token: string }> {
    const hostSocket = "unixSocket" in listen ? listen.unixSocket : undefined;
    // Fresh socket each turn (containers are never recovered, §11.2).
    if (hostSocket && existsSync(hostSocket)) {
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
    // Per-turn capability token: the shim must present it before any tool is
    // served (§3.1), so a peer that merely reaches the TCP port cannot invoke a
    // governed tool. Also authenticates the unix socket (defense in depth).
    const token = randomBytes(24).toString("hex");
    const conns: Socket[] = [];
    let server: Server | undefined;
    let port: number | undefined;
    if (gateway) {
      server = createServer((conn) => {
        conns.push(conn);
        serveToolBroker(conn, conn, gateway, govCtx, {
          tools: specs,
          onAskUser: this.opts.clarification ? onAskUser : undefined,
          authToken: token,
        });
      });
      const listening = new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server!.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server!.off("error", onError);
          resolve();
        };
        server!.once("error", onError);
        server!.once("listening", onListening);
      });
      if (hostSocket) {
        server.listen(hostSocket);
      } else {
        server.listen(0, "0.0.0.0");
      }
      try {
        await listening;
      } catch (err) {
        server.close();
        throw err;
      }
      const addr = server.address();
      port = addr && typeof addr === "object" ? addr.port : undefined;
    }
    return {
      close: () => {
        for (const c of conns) c.destroy();
        server?.close();
        if (hostSocket && existsSync(hostSocket)) {
          try {
            rmSync(hostSocket);
          } catch {
            /* ignore */
          }
        }
      },
      port,
      token,
    };
  }
}

function resultInvocation(
  acc: CodexStreamAccumulator,
  provider: string,
  model: string,
  latencyMs: number,
  subscription: boolean,
  spec: ReturnType<ModelRegistry["get"]>,
): ModelInvocationData {
  // Codex's usage schema is verify-on-pin (§4.3 #2); we estimate cost from the
  // accumulated token counts at the registry's prices. Under subscription no
  // per-token dollars are actually spent, so BILLABLE `costUsd` is 0 — otherwise
  // phantom cost would deplete the dollar budget for runs that cost nothing.
  const estimatedCostUsd = spec ? acc.estimatedCostUsd(spec) : null;
  return {
    provider,
    model,
    inputTokens: acc.usage.input,
    outputTokens: acc.usage.output,
    costUsd: subscription ? 0 : estimatedCostUsd,
    estimatedCostUsd,
    latencyMs,
    status: acc.terminal === "failed" ? "error" : "ok",
  };
}
