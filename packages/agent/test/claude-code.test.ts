import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  type AgentContainer,
  ClaudeCodeAgentRuntime,
  claudeSessionHostPath,
  decodeSessionRef,
  GUEST_BROKER_SOCKET,
} from "../src/claude-code";
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

const registry = new ModelRegistry([
  { provider: "anthropic", model: "claude-sonnet-4-6", cost: { input: 3, output: 15 } },
]);

/** A fake container whose `execStream` runs the given fake-`claude` script on the host. */
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

function sessionId(argv: string[]): string {
  const i = Math.max(argv.indexOf("--session-id"), argv.indexOf("--resume"));
  return argv[i + 1] ?? "";
}

function emit(onData: (b: Buffer) => void, ev: unknown): void {
  onData(Buffer.from(`${JSON.stringify(ev)}\n`));
}

async function callGoverned(socketPath: string): Promise<{ status: string; content?: string }> {
  const conn = connect(socketPath);
  await new Promise<void>((res, rej) => {
    conn.once("connect", res);
    conn.once("error", rej);
  });
  const client = new ToolBrokerClient(conn, conn);
  const tools = await client.listTools();
  const resp = await client.request({ tool: tools[0]?.name ?? "", input: {} });
  conn.destroy();
  return resp as { status: string; content?: string };
}

function writeSession(workspaceDir: string, sid: string, body: string): string {
  const p = claudeSessionHostPath({ workspaceDir, sessionId: sid });
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

describe("ClaudeCodeAgentRuntime (K7 — real broker/gateway, fake CLI)", () => {
  it("brokers a governed tool through the gateway, captures cost, snapshots the session", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "ccsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();

    const script: CliScript = async ({ argv, onData, socketPath, workspaceDir }) => {
      const sid = sessionId(argv);
      const resp = await callGoverned(socketPath);
      writeSession(workspaceDir, sid, `${JSON.stringify({ role: "user", content: "go" })}\n${JSON.stringify({ role: "assistant", content: resp.content })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "marathon", status: "connected" }] });
      emit(onData, { type: "assistant", message: { content: [{ type: "tool_use", name: "github_read_file", input: {} }], usage: { input_tokens: 100, output_tokens: 20 } } });
      emit(onData, { type: "result", subtype: "success", result: `read: ${resp.content}`, session_id: sid, total_cost_usd: 0.033, usage: { input_tokens: 100, output_tokens: 20 }, duration_api_ms: 999 });
      return { exitCode: 0 };
    };
    const { sandbox, seen } = fakeSandbox(script, ws);

    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({}),
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      proxy: { baseUrl: "http://proxy.internal:8080" },
    });

    const checkpoints: AgentTurnCheckpoint[] = [];
    const turn = await runtime.nextTurn({
      request: { taskId: "task1", instructions: "You are Forge.", input: "read the file", modelRef: "anthropic:claude-sonnet-4-6", tenantId: "tn1", agentId: "ag1" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: (cp) => void checkpoints.push(cp),
    });

    // The governed tool ran through the REAL gateway (audited host-side).
    expect(gov.invocations.some((r) => r.toolName === "github.read_file" && r.status === "ok")).toBe(true);
    expect(turn.text).toBe("read: FILE CONTENTS from host gateway");
    expect(turn.done).toBe(true);

    // Cost captured onto the checkpoint's ModelInvocation.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.modelInvocation?.costUsd).toBe(0.033);
    expect(checkpoints[0]?.modelInvocation?.provider).toBe("anthropic");

    // Session snapshotted; sessionRef decodes to id + snapshot path.
    const ref = decodeSessionRef(turn.sessionRef);
    expect(ref?.snapshot && existsSync(ref.snapshot)).toBeTruthy();

    // No key ever entered the container env — only the placeholder.
    expect(seen.env?.ANTHROPIC_API_KEY).toBe("marathon-proxy");
    expect(seen.env?.ANTHROPIC_BASE_URL).toBe("http://proxy.internal:8080");
    expect(JSON.stringify(seen.env)).not.toMatch(/sk-ant/);
  });

  it("restores the snapshot OVER a partial JSONL on resume (§5.2 turn atomicity)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "ccsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();

    let restoredAtStart: string | undefined;
    const script: CliScript = async ({ argv, onData, workspaceDir }) => {
      const sid = sessionId(argv);
      const p = claudeSessionHostPath({ workspaceDir, sessionId: sid });
      // What the runtime handed us at the start of this turn.
      restoredAtStart = existsSync(p) ? readFileSync(p, "utf8") : undefined;
      writeSession(workspaceDir, sid, "CLEAN-SESSION\n");
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      emit(onData, { type: "result", subtype: "success", result: "ok", session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({}),
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      proxy: { baseUrl: "http://proxy.internal:8080" },
    });

    // Turn 0: produces a snapshot.
    const t0 = await runtime.nextTurn({
      request: { taskId: "task2", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    const ref0 = decodeSessionRef(t0.sessionRef)!;
    const snapshotContent = readFileSync(ref0.snapshot!, "utf8");

    // Simulate a crashed invocation leaving a partial file at the live path.
    writeSession(ws.dir, ref0.sessionId, "PARTIAL-GARBAGE-FROM-CRASH\n");

    // Turn 1: resume — the runtime must restore the snapshot over the partial.
    await runtime.nextTurn({
      request: { taskId: "task2", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: ["turn:0"], findings: [], sessionRef: t0.sessionRef, turnIndex: 0 } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    expect(restoredAtStart).toBe(snapshotContent);
    expect(restoredAtStart).not.toContain("PARTIAL-GARBAGE");
  });

  it("direct mode (bridge default): injects the Marathon key, no proxy, no ANTHROPIC_BASE_URL (§4.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "ccsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ argv, onData, workspaceDir }) => {
      const sid = sessionId(argv);
      writeSession(workspaceDir, sid, `${JSON.stringify({ role: "assistant", content: "ok" })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      emit(onData, { type: "result", subtype: "success", result: "ok", session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
      return { exitCode: 0 };
    };
    const { sandbox, seen } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      // The Marathon-dedicated spend key lives in the secret store.
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "sk-ant-marathon" }),
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      // no proxy wired → direct mode on bridge (the default)
    });
    await runtime.nextTurn({
      request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    // The real key is injected directly; there is NO proxy base URL.
    expect(seen.env?.ANTHROPIC_API_KEY).toBe("sk-ant-marathon");
    expect(seen.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("uses a SHORT default broker socket path (macOS sun_path limit) when no socketDir is set", async () => {
    // Regression: the old default (process.cwd()/.marathon-sockets + full-UUID
    // filename) overflowed the ~104-byte unix socket limit and crashed with
    // listen EINVAL. With no socketDir, the run must succeed on a short path.
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const gov = governedGateway();
    let sockLen = 0;
    const script: CliScript = async ({ argv, onData, socketPath, workspaceDir }) => {
      sockLen = socketPath.length;
      const sid = sessionId(argv);
      writeSession(workspaceDir, sid, `${JSON.stringify({ role: "assistant", content: "ok" })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      emit(onData, { type: "result", subtype: "success", result: "ok", session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "sk-ant-marathon" }),
      registry,
      sandbox, // no socketDir → the short tmp default
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    const turn = await runtime.nextTurn({
      request: { taskId: "492b7919-cc15-4ce4-9368-bb4592ef9b1c", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    expect(turn.text).toBe("ok"); // did not crash on listen EINVAL
    expect(sockLen).toBeGreaterThan(0);
    expect(sockLen).toBeLessThanOrEqual(103);
  });

  it("surfaces the CLI's stderr when the run exits non-zero with no result event", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    // A CLI that writes an auth error to STDERR and exits 1, emitting no result.
    // The stderr echoes a realistic-length token that redaction must scrub.
    const leakToken = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const script: CliScript = async () => ({
      exitCode: 1,
      stderr: `Invalid API key · Please run /login (token ${leakToken})\n`,
    });
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "k" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    const err = await runtime
      .nextTurn({
        request: { taskId: "t", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      })
      .catch((e: Error) => e);
    expect(String(err)).toContain("exit 1");
    expect(String(err)).toContain("Invalid API key"); // the real reason is surfaced
    expect(String(err)).not.toContain(leakToken); // …but the token is redacted
  });

  it("fails with an actionable error (not EINVAL) when a custom socketDir overflows the limit", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const gov = governedGateway();
    const { sandbox } = fakeSandbox(async () => ({ exitCode: 0 }), ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "k" }),
      registry,
      socketDir: join(tmpdir(), "x".repeat(120)), // dir is creatable, but the socket path overflows
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "t", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/too long for a unix domain socket/);
  });

  it("subscription mode: CLAUDE_CODE_OAUTH_TOKEN in the env is injected, no ANTHROPIC_API_KEY (§4.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const sessionDir = mkdtempSync(join(tmpdir(), "ccsess-"));
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    const script: CliScript = async ({ argv, onData, workspaceDir }) => {
      const sid = sessionId(argv);
      writeSession(workspaceDir, sid, `${JSON.stringify({ role: "assistant", content: "ok" })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      emit(onData, { type: "result", subtype: "success", result: "ok", session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      return { exitCode: 0 };
    };
    const { sandbox, seen } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      // Both set → subscription wins; the OAuth token maps from CLAUDE_CODE_OAUTH_TOKEN
      // via the EnvSecretStore convention (secret/claude-code-oauth-token).
      secrets: new EnvSecretStore({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-xyz", ANTHROPIC_API_KEY: "sk-ant-key" }),
      registry,
      sessionDir,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await runtime.nextTurn({
      request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    expect(seen.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-xyz");
    expect(seen.env?.ANTHROPIC_API_KEY).toBeUndefined(); // subscription, not per-token API billing
    expect(seen.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("direct mode fails closed when no Anthropic key is configured (§4.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    const script: CliScript = async () => ({ exitCode: 0 });
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({}), // no key
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      // no proxy wired
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/needs a model credential/);
  });

  it("fails closed BEFORE provisioning the broker — no leaked socket (review)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    const script: CliScript = async () => ({ exitCode: 0 });
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({}), // no key → direct mode fails closed
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/needs a model credential/);
    // Model access is resolved before the broker socket is created — nothing leaks.
    expect(existsSync(socketDir) ? readdirSync(socketDir).filter((f) => f.endsWith(".sock")) : []).toEqual([]);
  });

  it("closes the broker when container creation fails after it started (review)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    // A sandbox that starts the broker (via the runtime) then fails to create the container.
    const sandbox = {
      createContainer: () => {
        throw new Error("docker daemon unavailable");
      },
    } as never;
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "sk-ant-marathon" }),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/docker daemon unavailable/);
    // The finally ran broker.close(), which removes the socket — no leak.
    expect(readdirSync(socketDir).filter((f) => f.endsWith(".sock"))).toEqual([]);
  });

  it("locked-down egress requires the proxy — a key can't reach the model with no egress (§4.1)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    const script: CliScript = async () => ({ exitCode: 0 });
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ ANTHROPIC_API_KEY: "sk-ant-marathon" }), // even WITH a key
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      lockedDownEgress: true, // network: none — no egress except the proxy
      // no proxy wired
    });
    await expect(
      runtime.nextTurn({
        request: { taskId: "task0", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/locked-down egress .* requires the model proxy/);
  });

  it("kills the invocation when streamed usage breaches the remaining budget (§4.3)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();

    const script: CliScript = async ({ argv, onData, signal }) => {
      const sid = sessionId(argv);
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      // A single huge-usage assistant message pushes estimated cost past the cap.
      emit(onData, { type: "assistant", message: { content: [{ type: "text", text: "..." }], usage: { input_tokens: 5_000_000, output_tokens: 0 } } });
      // Wait to be aborted (the runaway that a between-turn check can't stop).
      await new Promise<void>((_res, rej) => {
        if (signal?.aborted) return rej(new Error("aborted"));
        signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({}),
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      proxy: { baseUrl: "http://proxy.internal:8080" },
      getRemainingBudgetUsd: () => 0.0001,
    });

    await expect(
      runtime.nextTurn({
        request: { taskId: "task3", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
        checkpoint: { completedSteps: [], findings: [] } as never,
        workspace: ws,
        onTurnCheckpoint: () => {},
      }),
    ).rejects.toThrow(/budget exceeded mid-invocation/);
  });

  it("does NOT apply the mid-invocation budget kill under subscription (§4.1 — no per-token cost)", async () => {
    const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "ccws-")), baseSha: "base" };
    const socketDir = mkdtempSync(join(tmpdir(), "ccsock-"));
    const gov = governedGateway();
    let budgetChecked = false;
    const script: CliScript = async ({ argv, onData, workspaceDir }) => {
      const sid = sessionId(argv);
      writeSession(workspaceDir, sid, `${JSON.stringify({ role: "assistant", content: "ok" })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid });
      // Huge usage that WOULD breach a tiny cap at API prices — but subscription
      // isn't metered in dollars, so this must not abort the run.
      emit(onData, { type: "assistant", message: { content: [{ type: "text", text: "..." }], usage: { input_tokens: 5_000_000, output_tokens: 0 } } });
      emit(onData, { type: "result", subtype: "success", result: "done", session_id: sid, total_cost_usd: 0, usage: { input_tokens: 5_000_000, output_tokens: 0 } });
      return { exitCode: 0 };
    };
    const { sandbox } = fakeSandbox(script, ws);
    const runtime = new ClaudeCodeAgentRuntime({
      secrets: new EnvSecretStore({ CLAUDE_CODE_OAUTH_TOKEN: "oat" }), // subscription
      registry,
      socketDir,
      sandbox,
      governed: { gateway: gov.gateway, tools: gov.tools },
      // The runtime must not even consult the budget under subscription.
      getRemainingBudgetUsd: () => {
        budgetChecked = true;
        return 0.0001;
      },
    });
    const turn = await runtime.nextTurn({
      request: { taskId: "task3", instructions: "i", input: "go", modelRef: "anthropic:claude-sonnet-4-6" },
      checkpoint: { completedSteps: [], findings: [] } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
    expect(turn.text).toBe("done"); // completed, not killed
    expect(budgetChecked).toBe(false); // USD budget is inert under subscription
  });
});
