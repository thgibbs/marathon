import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore } from "@marathon/config";
import { ModelRegistry } from "@marathon/model-gateway";
import {
  type AuditRecord,
  ToolBrokerClient,
  ToolGateway,
  type ToolInvocationRecord,
  ToolRegistry,
  type Tool,
  type ToolPolicy,
} from "@marathon/tools";
import { describe, expect, it } from "vitest";
import { type AgentContainer, GUEST_BROKER_SOCKET } from "../src/claude-code";
import { CodexAgentRuntime, codexConfigHostPath, codexSessionHostPath } from "../src/codex";
import { decodeSessionRef } from "../src/claude-code";
import type { AgentTurnCheckpoint, AgentWorkspaceBinding } from "../src/types";

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;

function governedGateway() {
  const invocations: ToolInvocationRecord[] = [];
  const audits: AuditRecord[] = [];
  const tool: Tool = {
    name: "github.read_file",
    description: "read a file",
    riskAxes: AXES,
    defaultMode: "autonomous",
    async execute() {
      return { content: "FILE CONTENTS from host gateway" };
    },
  };
  const gateway = new ToolGateway({
    registry: new ToolRegistry([tool]),
    policy: { grants: [{ tool: "github.read_file" }] } as ToolPolicy,
    secrets: new EnvSecretStore({}),
    recorder: {
      onInvocation: (r) => void invocations.push(r),
      onAudit: (a) => void audits.push(a),
    },
  });
  const tools = [{ name: "github.read_file", description: "read a file", parameters: { type: "object" } }];
  return { gateway, tools, invocations, audits };
}

const registry = new ModelRegistry([{ provider: "openai", model: "gpt-5-codex", cost: { input: 3, output: 15 } }]);

type CliScript = (args: {
  argv: string[];
  env: Record<string, string>;
  onData: (b: Buffer) => void;
  signal?: AbortSignal;
  socketPath: string;
  workspaceDir: string;
}) => Promise<{ exitCode: number; stderr?: string; stdout?: string }>;

function fakeSandbox(script: CliScript, workspace: AgentWorkspaceBinding) {
  const seen: { env?: Record<string, string>; argv?: string[] } = {};
  const sandbox = {
    createContainer: (_req: unknown, _ws: AgentWorkspaceBinding | undefined, extra?: { mounts?: { source: string; target: string }[] }) => {
      const socketPath = extra?.mounts?.find((m) => m.target === GUEST_BROKER_SOCKET)?.source ?? "";
      const container: AgentContainer = {
        async start() {},
        async stop() {},
        async execStream(argv, opts = {}) {
          seen.argv = argv;
          seen.env = opts.env;
          const r = await script({
            argv,
            env: opts.env ?? {},
            onData: opts.onData ?? (() => {}),
            signal: opts.signal,
            socketPath,
            workspaceDir: workspace.dir,
          });
          return { exitCode: r.exitCode, stdout: Buffer.from(r.stdout ?? ""), stderr: Buffer.from(r.stderr ?? "") };
        },
      };
      return container;
    },
  };
  return { sandbox, seen };
}

/** The session id in the argv: `resume <sid>` on a resume, else the CLI mints it. */
function resumeIdFrom(argv: string[]): string | undefined {
  const i = argv.indexOf("resume");
  return i >= 0 ? argv[i + 1] : undefined;
}

function emit(onData: (b: Buffer) => void, ev: unknown): void {
  onData(Buffer.from(`${JSON.stringify(ev)}\n`));
}

/** Read the broker connect target out of the config.toml the runtime wrote (§3.1). */
function brokerTargetFromConfig(workspaceDir: string): { socket?: string; tcp?: string; token?: string } {
  const toml = readFileSync(codexConfigHostPath({ workspaceDir }), "utf8");
  const argsLine = toml.split("\n").find((l) => l.startsWith("args ="))!;
  const args: string[] = JSON.parse(argsLine.slice(argsLine.indexOf("[")));
  const val = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { socket: val("--socket"), tcp: val("--tcp"), token: val("--token") };
}

async function callGoverned(target: { socket?: string; tcp?: string; token?: string }): Promise<{ status: string; content?: string }> {
  const conn = target.tcp
    ? connect(Number(target.tcp.slice(target.tcp.lastIndexOf(":") + 1)), target.tcp.slice(0, target.tcp.lastIndexOf(":")))
    : connect(target.socket ?? "");
  await new Promise<void>((res, rej) => {
    conn.once("connect", res);
    conn.once("error", rej);
  });
  if (target.token) conn.write(`${JSON.stringify({ auth: target.token })}\n`);
  const client = new ToolBrokerClient(conn, conn);
  const tools = await client.listTools();
  const resp = await client.request({ tool: tools[0]?.name ?? "", input: {} });
  conn.destroy();
  return resp as { status: string; content?: string };
}

/** Write session state under $CODEX_HOME/sessions (what the fake CLI persists). */
function writeSession(workspaceDir: string, body: string): string {
  const dir = codexSessionHostPath({ workspaceDir });
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "rollout.jsonl");
  writeFileSync(p, body);
  return p;
}

describe("CodexAgentRuntime (K8 — real broker/gateway, fake CLI)", () => {
  it("brokers a governed tool through the gateway, captures cost, snapshots the session", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "cxsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();

    const script: CliScript = async ({ onData, socketPath, workspaceDir }) => {
      const sid = "th-minted-001"; // Codex mints its own id, reported via thread.started
      const resp = await callGoverned({ socket: socketPath, token: brokerTargetFromConfig(workspaceDir).token });
      writeSession(workspaceDir, `${JSON.stringify({ role: "assistant", content: resp.content })}\n`);
      emit(onData, { type: "thread.started", thread_id: sid });
      emit(onData, { type: "turn.started" });
      emit(onData, { type: "item.completed", item: { item_type: "mcp_tool_call", tool: "github_read_file" } });
      emit(onData, { type: "turn.completed", agent_message: `read: ${resp.content}`, usage: { input_tokens: 100, output_tokens: 20 } });
      return { exitCode: 0 };
    };
    const { sandbox, seen } = fakeSandbox(script, ws);

    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon" }), // secret/openai-codex
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });

    const checkpoints: AgentTurnCheckpoint[] = [];
    const turn = await runtime.nextTurn({
      request: { taskId: "task1", instructions: "You are Forge.", input: "read the file", modelRef: "openai:gpt-5-codex", tenantId: "tn1", agentId: "ag1" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: (cp) => void checkpoints.push(cp),
    });

    expect(gov.invocations.some((r) => r.toolName === "github.read_file" && r.status === "ok")).toBe(true);
    expect(turn.text).toBe("read: FILE CONTENTS from host gateway");
    expect(turn.done).toBe(true);

    // Cost estimated from usage onto the checkpoint's ModelInvocation.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.modelInvocation?.provider).toBe("openai");
    expect(checkpoints[0]?.modelInvocation?.costUsd).toBeCloseTo((100 * 3 + 20 * 15) / 1_000_000, 10);

    // Session subtree snapshotted; sessionRef decodes to id + snapshot path.
    const ref = decodeSessionRef(turn.sessionRef);
    expect(ref?.sessionId).toBe("th-minted-001");
    expect(ref?.snapshot && existsSync(ref.snapshot)).toBeTruthy();

    // The real key was injected into the container env as CODEX_API_KEY; no proxy.
    expect(seen.env?.CODEX_API_KEY).toBe("sk-openai-marathon");
    expect(seen.env?.CODEX_HOME).toBe("/workspace/.marathon-home/.codex");
    // No secret material in the argv.
    expect((seen.argv ?? []).join(" ")).not.toContain("sk-openai");
  });

  it("brokers a governed tool over the TCP transport (brokerHost) end to end (§3.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const gov = governedGateway();

    let usedTcp: string | undefined;
    const script: CliScript = async ({ onData, socketPath, workspaceDir }) => {
      const target = brokerTargetFromConfig(workspaceDir);
      usedTcp = target.tcp;
      expect(socketPath).toBe(""); // no unix socket mounted in TCP mode
      const resp = await callGoverned(target);
      writeSession(workspaceDir, `${JSON.stringify({ role: "assistant", content: resp.content })}\n`);
      emit(onData, { type: "thread.started", thread_id: "th-tcp" });
      emit(onData, { type: "turn.completed", agent_message: `read: ${resp.content}`, usage: { input_tokens: 10, output_tokens: 5 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);

    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon" }),
      registry,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      brokerHost: "127.0.0.1",
    });

    const turn = await runtime.nextTurn({
      request: { taskId: "task-tcp", instructions: "i", input: "read the file", modelRef: "openai:gpt-5-codex", tenantId: "tn1", agentId: "ag1" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });

    expect(usedTcp).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(gov.invocations.some((r) => r.toolName === "github.read_file" && r.status === "ok")).toBe(true);
    expect(turn.done).toBe(true);
  });

  it("restores the snapshot subtree OVER partial state on resume, passing `resume <sid>` (§5.2/§2.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "cxsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();

    let restoredAtStart: string | undefined;
    let resumeArg: string | undefined;
    const script: CliScript = async ({ argv, onData, workspaceDir }) => {
      resumeArg = resumeIdFrom(argv);
      const rollout = join(codexSessionHostPath({ workspaceDir }), "rollout.jsonl");
      restoredAtStart = existsSync(rollout) ? readFileSync(rollout, "utf8") : undefined;
      const sid = resumeArg ?? "th-first";
      writeSession(workspaceDir, "CLEAN-STATE\n");
      emit(onData, { type: "thread.started", thread_id: sid });
      emit(onData, { type: "turn.completed", agent_message: "ok", usage: { input_tokens: 1, output_tokens: 1 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon" }),
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });

    // Turn 0 → snapshot.
    const t0 = await runtime.nextTurn({
      request: { taskId: "task2", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    const ref0 = decodeSessionRef(t0.sessionRef)!;
    const snapshotContent = readFileSync(join(ref0.snapshot!, "rollout.jsonl"), "utf8");

    // Simulate a crashed invocation leaving a partial file at the live path.
    writeSession(ws.dir, "PARTIAL-GARBAGE-FROM-CRASH\n");

    // Turn 1: resume — restore the snapshot subtree over the partial + `resume <sid>`.
    await runtime.nextTurn({
      request: { taskId: "task2", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
      checkpoint: { completedSteps: ["turn:0"], findings: [], sessionRef: t0.sessionRef, turnIndex: 0 } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    expect(resumeArg).toBe(ref0.sessionId); // resumed with the minted id
    expect(restoredAtStart).toBe(snapshotContent);
    expect(restoredAtStart).not.toContain("PARTIAL-GARBAGE");
  });

  it("fails closed when no OpenAI key is configured (direct mode, §4.1) — before provisioning the broker", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const { sandbox } = fakeSandbox(async () => ({ exitCode: 0 }), ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({}), // no key
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "task0", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/needs a model credential/);
    // No broker socket leaked — model access is resolved first.
    expect(existsSync(socketDir) ? readdirSync(socketDir).filter((f) => f.endsWith(".sock")) : []).toEqual([]);
  });

  it("locked-down egress fails closed (no OpenAI proxy exists, §4.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const { sandbox } = fakeSandbox(async () => ({ exitCode: 0 }), ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon" }), // even WITH a key
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      lockedDownEgress: true,
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/no route to the OpenAI API/);
  });

  it("surfaces turn.failed as a not-done error the step runner retries (§2.2)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ onData }) => {
      emit(onData, { type: "thread.started", thread_id: "th-x" });
      emit(onData, { type: "turn.failed", error: { message: "model overloaded" } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/codex turn failed: model overloaded/);
  });

  it("a required=true MCP startup failure fails the invocation — never a governed-tool-less run (§4.2, §10 #12)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    // A wedged/absent shim under `required = true`: the CLI exits nonzero with
    // no thread.started and no terminal event — the turn must fail fast with the
    // exit code + stderr surfaced, and nothing may be checkpointed.
    const script: CliScript = async () => ({
      exitCode: 1,
      stderr: "error: required MCP server 'marathon' failed to start (startup_timeout_sec exceeded)",
    });
    const { sandbox } = fakeSandbox(script, ws);
    const checkpoints: AgentTurnCheckpoint[] = [];
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: (c) => void checkpoints.push(c),
      }),
    ).rejects.toThrow(/\(exit 1\)[\s\S]*required MCP server 'marathon' failed to start/);
    expect(checkpoints).toEqual([]);
  });

  it("subscription mode (acknowledged): stages auth.json into $CODEX_HOME, no CODEX_API_KEY, bills $0 (§4.1)", async () => {
    const prev = process.env.MARATHON_CODEX_SUBSCRIPTION_DEV;
    process.env.MARATHON_CODEX_SUBSCRIPTION_DEV = "1"; // acknowledge the dev-only posture
    try {
      const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
      const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
      const authJsonPath = join(mkdtempSync(join(tmpdir(), "cxauth-")), "auth.json");
      writeFileSync(authJsonPath, '{"tokens":{"access":"CHATGPT-LOGIN-SECRET"}}');
      const gov = governedGateway();
      const script: CliScript = async ({ onData, workspaceDir }) => {
        // The CLI reads the staged credential from $CODEX_HOME/auth.json.
        const staged = join(workspaceDir, ".marathon-home/.codex/auth.json");
        expect(readFileSync(staged, "utf8")).toBe('{"tokens":{"access":"CHATGPT-LOGIN-SECRET"}}');
        expect(statSync(staged).mode & 0o777).toBe(0o600);
        writeSession(workspaceDir, "s\n");
        emit(onData, { type: "thread.started", thread_id: "th-sub" });
        emit(onData, { type: "turn.completed", agent_message: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
        return { exitCode: 0 };
      };
      const { sandbox, seen } = fakeSandbox(script, ws);
      const runtime = new CodexAgentRuntime({
        secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-ignored" }),
        registry,
        socketDir,
        sandbox,
        sessionDir: mkdtempSync(join(tmpdir(), "cxsess-")),
        governed: { gateway: gov.gateway, tools: gov.tools },
        subscriptionAuthJsonPath: authJsonPath,
      });
      const checkpoints: AgentTurnCheckpoint[] = [];
      const turn = await runtime.nextTurn({
        request: { taskId: "t-sub", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: (cp) => void checkpoints.push(cp),
      });
      expect(turn.text).toBe("ok");
      expect(seen.env?.CODEX_API_KEY).toBeUndefined(); // subscription, not per-token billing
      // The credential never rides env or argv — it moves as a file only.
      expect(JSON.stringify(seen.env)).not.toContain("CHATGPT-LOGIN-SECRET");
      expect(JSON.stringify(seen.argv)).not.toContain("CHATGPT-LOGIN-SECRET");
      // The real API key was never injected even though it was in the store.
      expect(JSON.stringify(seen.env)).not.toContain("sk-openai-ignored");
      // The per-turn session snapshot (sessions subtree only) can NEVER capture
      // the credential — auth.json sits at the CODEX_HOME root beside it (§5.2).
      const snapshot = decodeSessionRef(turn.sessionRef)?.snapshot;
      expect(snapshot && existsSync(snapshot)).toBe(true);
      expect(existsSync(join(snapshot!, "auth.json"))).toBe(false);
      const mi = checkpoints[0]?.modelInvocation;
      expect(mi?.costUsd).toBe(0); // billable dollars — none under subscription
      expect(mi?.estimatedCostUsd).toBeCloseTo((100 * 3 + 20 * 15) / 1_000_000, 10); // …estimate still tracked
    } finally {
      if (prev === undefined) delete process.env.MARATHON_CODEX_SUBSCRIPTION_DEV;
      else process.env.MARATHON_CODEX_SUBSCRIPTION_DEV = prev;
    }
  });

  it("subscription without the ack env fails closed (§4.1)", async () => {
    const prev = process.env.MARATHON_CODEX_SUBSCRIPTION_DEV;
    delete process.env.MARATHON_CODEX_SUBSCRIPTION_DEV;
    try {
      const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
      const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
      const gov = governedGateway();
      const { sandbox } = fakeSandbox(async () => ({ exitCode: 0 }), ws);
      const runtime = new CodexAgentRuntime({
        secrets: new EnvSecretStore({}),
        registry,
        socketDir,
        sandbox,
        governed: { gateway: gov.gateway, tools: gov.tools },
        subscriptionAuthJsonPath: "/home/dev/.codex/auth.json",
      });
      await expect(
        runtime.nextTurn({
          request: { taskId: "t", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
          checkpoint: { completedSteps: [], findings: [] } as never,
          workspace: ws,
          onTurnCheckpoint: () => {},
        }),
      ).rejects.toThrow(/DEV-ONLY/);
    } finally {
      if (prev !== undefined) process.env.MARATHON_CODEX_SUBSCRIPTION_DEV = prev;
    }
  });

  it("kills the invocation when streamed (pre-terminal) usage breaches the budget (§4.3)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ onData, signal }) => {
      emit(onData, { type: "thread.started", thread_id: "th-big" });
      // Per-ITEM usage before the terminal event triggers the mid-turn kill.
      emit(onData, { type: "item.completed", item: { item_type: "agent_message", text: "...", usage: { input_tokens: 5_000_000, output_tokens: 0 } } });
      await new Promise<void>((_res, rej) => {
        if (signal?.aborted) return rej(new Error("aborted"));
        signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      getRemainingBudgetUsd: () => 0.0001,
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t3", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/budget exceeded mid-invocation/);
  });

  it("does NOT engage the mid-turn kill when usage only lands on turn.completed (§4.3 hook is a no-op)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ onData, workspaceDir }) => {
      writeSession(workspaceDir, "s\n");
      emit(onData, { type: "thread.started", thread_id: "th-late" });
      // Usage ONLY on the terminal event — no pre-terminal usage to trip the kill.
      emit(onData, { type: "turn.completed", agent_message: "done", usage: { input_tokens: 5_000_000, output_tokens: 0 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      getRemainingBudgetUsd: () => 0.0001, // tiny cap the terminal usage blows past
    });
    const turn = await runtime.nextTurn({
      request: { taskId: "t4", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    // Completed, not killed — the hook only engages on pre-terminal usage.
    expect(turn.text).toBe("done");
    expect(turn.done).toBe(true);
  });

  it("wall-clock watchdog kills a runaway and discards the turn (§2.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "cxws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "cxsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ onData, signal }) => {
      emit(onData, { type: "thread.started", thread_id: "th-slow" });
      await new Promise<void>((_res, rej) => {
        signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new CodexAgentRuntime({
      secrets: new EnvSecretStore({ OPENAI_CODEX: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      maxWallClockMsPerInvocation: 20,
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t5", instructions: "i", input: "go", modelRef: "openai:gpt-5-codex" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/wall-clock budget/);
  });
});
