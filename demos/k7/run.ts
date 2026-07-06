/**
 * K7 demo (roadmap §2c): the Claude Code (headless) harness drives the SAME task
 * pipeline green through the REAL broker, gateway, and container seam — a
 * recorded/fake `claude` CLI (canned stream-json) standing in for the model so the
 * demo is deterministic, needs no network, and holds no key.
 *
 * It exercises, end to end:
 *  - governed tools over MCP: the fake CLI talks the real marathon-mcp-shim handler
 *    → ToolBrokerClient → unix socket → serveToolBroker → ToolGateway (validate →
 *    policy → redact → audit). Tool results cross back pre-redacted;
 *  - typed refusals preserved: a proposed_effect tool comes back as
 *    "[requires proposal] …", not a leaked execution;
 *  - checkpoint cadence + turn atomicity: turn 1 stops on `error_max_turns`
 *    (not done) and checkpoints; a simulated crash scribbles a partial session
 *    JSONL; turn 2 RESUMES, and the runtime restores the snapshot OVER the
 *    partial before `--resume` (§5.2);
 *  - cost captured per turn into ModelInvocation;
 *  - key hygiene: only the placeholder ANTHROPIC_API_KEY ever enters the container
 *    env; the real key never does;
 *  - mid-invocation budget kill (§4.3): a runaway single invocation is killed when
 *    streamed usage breaches the remaining task budget.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EnvSecretStore } from "@marathon/config";
import {
  type AgentContainer,
  ClaudeCodeAgentRuntime,
  claudeSessionHostPath,
  decodeSessionRef,
  GUEST_BROKER_SOCKET,
  type AgentTurnCheckpoint,
  type AgentWorkspaceBinding,
} from "@marathon/agent";
import { handleMcpRequest } from "@marathon/mcp-shim";
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

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;

const registry = new ModelRegistry([{ provider: "anthropic", model: "claude-sonnet-4-6", cost: { input: 3, output: 15 } }]);

function governed() {
  const invocations: ToolInvocationRecord[] = [];
  const audits: AuditRecord[] = [];
  const readTool: Tool = {
    name: "github.read_file",
    description: "read a file from the repo",
    riskAxes: AXES,
    defaultMode: "autonomous",
    async execute() {
      return { content: "export const answer = 42;" };
    },
  };
  const deleteTool: Tool = {
    name: "doc.delete",
    description: "delete a document",
    riskAxes: { ...AXES, reversible: false },
    defaultMode: "proposed_effect",
    async execute() {
      return { content: "deleted" };
    },
  };
  const gateway = new ToolGateway({
    registry: new ToolRegistry([readTool, deleteTool]),
    policy: { grants: [{ tool: "github.read_file" }, { tool: "doc.delete" }] } as ToolPolicy,
    secrets: new EnvSecretStore({}),
    recorder: { onInvocation: (r) => void invocations.push(r), onAudit: (a) => void audits.push(a) },
  });
  const tools = [
    { name: "github.read_file", description: "read a file from the repo", parameters: { type: "object" } },
    { name: "doc.delete", description: "delete a document", parameters: { type: "object" } },
  ];
  return { gateway, tools, invocations, audits };
}

/** A broker client wrapped as the shim's BrokerLike, so the demo runs the real MCP handler. */
async function connectShimBroker(socketPath: string) {
  const conn = connect(socketPath);
  await new Promise<void>((res, rej) => {
    conn.once("connect", res);
    conn.once("error", rej);
  });
  const client = new ToolBrokerClient(conn, conn);
  const broker = {
    listTools: () => client.listTools(),
    request: (req: { tool: string; input: Record<string, unknown> }) => client.request(req),
  };
  return { conn, broker };
}

/** Call a governed tool exactly as Claude would: an MCP tools/call through the shim. */
async function mcpCall(broker: Parameters<typeof handleMcpRequest>[0], name: string): Promise<string> {
  const resp = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const content = (resp?.result as { content: { text: string }[] }).content;
  return content[0]?.text ?? "";
}

function sessionId(argv: string[]): string {
  const i = Math.max(argv.indexOf("--session-id"), argv.indexOf("--resume"));
  return argv[i + 1] ?? "";
}
function emit(onData: (b: Buffer) => void, ev: unknown): void {
  onData(Buffer.from(`${JSON.stringify(ev)}\n`));
}

type Script = (a: {
  argv: string[];
  env: Record<string, string>;
  onData: (b: Buffer) => void;
  signal?: AbortSignal;
  socketPath: string;
  workspaceDir: string;
}) => Promise<{ exitCode: number }>;

function fakeSandbox(script: Script, ws: AgentWorkspaceBinding) {
  const seen: { env?: Record<string, string> } = {};
  const sandbox = {
    createContainer: (_r: unknown, _w: AgentWorkspaceBinding | undefined, extra?: { mounts?: { source: string; target: string }[] }) => {
      const socketPath = extra?.mounts?.find((m) => m.target === GUEST_BROKER_SOCKET)?.source ?? "";
      const c: AgentContainer = {
        async start() {},
        async stop() {},
        async execStream(argv, opts = {}) {
          seen.env = opts.env;
          const r = await script({ argv, env: opts.env ?? {}, onData: opts.onData ?? (() => {}), signal: opts.signal, socketPath, workspaceDir: ws.dir });
          return { exitCode: r.exitCode, stdout: Buffer.from(""), stderr: Buffer.from("") };
        },
      };
      return c;
    },
  };
  return { sandbox, seen };
}

async function main(): Promise<void> {
  console.log("K7 demo — Claude Code harness through the real broker/gateway (fake CLI)\n");
  const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "k7ws-")), baseSha: "base-sha" };
  const sessionDir = mkdtempSync(join(tmpdir(), "k7sess-"));
  const socketDir = mkdtempSync(join(tmpdir(), "k7sock-"));
  const gov = governed();

  let refusalSeen = "";
  let restoredOnResume: string | undefined;

  const script: Script = async ({ argv, onData, socketPath, workspaceDir }) => {
    const sid = sessionId(argv);
    const resume = argv.includes("--resume");
    const sessPath = claudeSessionHostPath({ workspaceDir, sessionId: sid });

    if (!resume) {
      // Turn 1: read a file (autonomous) + attempt a delete (proposed_effect).
      const { conn, broker } = await connectShimBroker(socketPath);
      const read = await mcpCall(broker, "github_read_file");
      refusalSeen = await mcpCall(broker, "doc_delete");
      conn.destroy();
      writeFileSync(sessPath, ensureDir(sessPath) + `${JSON.stringify({ role: "assistant", content: read })}\n`);
      emit(onData, { type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "marathon", status: "connected" }] });
      emit(onData, { type: "assistant", message: { content: [{ type: "tool_use", name: "github_read_file", input: {} }], usage: { input_tokens: 200, output_tokens: 30 } } });
      // Stop on the checkpoint cap — not done; the runtime checkpoints and resumes.
      emit(onData, { type: "result", subtype: "error_max_turns", session_id: sid, total_cost_usd: 0.021, usage: { input_tokens: 200, output_tokens: 30 }, duration_api_ms: 800 });
      return { exitCode: 0 };
    }

    // Turn 2 (resume): the runtime restored the snapshot over the crash's partial.
    restoredOnResume = existsSync(sessPath) ? readFileSync(sessPath, "utf8") : undefined;
    writeFileSync(sessPath, `${restoredOnResume ?? ""}${JSON.stringify({ role: "assistant", content: "implemented; PR opened" })}\n`);
    emit(onData, { type: "system", subtype: "init", session_id: sid });
    emit(onData, { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 80, output_tokens: 20 } } });
    emit(onData, { type: "result", subtype: "success", result: "implemented; PR opened", session_id: sid, total_cost_usd: 0.019, usage: { input_tokens: 80, output_tokens: 20 }, duration_api_ms: 500 });
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

  const request = { taskId: "k7-task", instructions: "You are Forge.", input: "implement the plan", modelRef: "anthropic:claude-sonnet-4-6", tenantId: "tn1", agentId: "ag1" };

  // --- Turn 1: not done, checkpoint captured ---
  console.log("Turn 1 (governed tools + checkpoint on --max-turns):");
  const cps: AgentTurnCheckpoint[] = [];
  const t1 = await runtime.nextTurn({
    request,
    checkpoint: { completedSteps: [], findings: [] } as never,
    workspace: ws,
    onTurnCheckpoint: (cp) => void cps.push(cp),
  });
  assert(t1.done === false, "turn 1 is NOT done (stopped on error_max_turns → continue)");
  assert(gov.invocations.some((r) => r.toolName === "github.read_file" && r.status === "ok"), "github.read_file ran through the gateway and was audited");
  assert(refusalSeen.startsWith("[requires proposal]"), "doc.delete came back as a typed proposed-effect refusal, not an execution");
  assert(!gov.invocations.some((r) => r.toolName === "doc.delete" && r.status === "ok"), "the proposed-effect tool never executed");
  assert(cps[0]?.modelInvocation?.costUsd === 0.021, "turn 1 cost captured onto the checkpoint");
  assert(seen.env?.ANTHROPIC_API_KEY === "marathon-proxy" && !JSON.stringify(seen.env).includes("sk-ant"), "only the placeholder key entered the container env");

  // --- Simulate a crash: scribble a partial session file ---
  const ref = decodeSessionRef(t1.sessionRef)!;
  const snapshot = readFileSync(ref.snapshot!, "utf8");
  writeFileSync(claudeSessionHostPath({ workspaceDir: ws.dir, sessionId: ref.sessionId }), "PARTIAL-GARBAGE-FROM-CRASH\n");

  // --- Turn 2: resume to completion ---
  console.log("\nTurn 2 (resume; snapshot restored over the partial):");
  const t2 = await runtime.nextTurn({
    request,
    checkpoint: { completedSteps: ["turn:0"], findings: [], sessionRef: t1.sessionRef, turnIndex: 0 } as never,
    workspace: ws,
    onTurnCheckpoint: (cp) => void cps.push(cp),
  });
  assert(t2.done === true, "turn 2 completes the run (subtype success)");
  assert(t2.text === "implemented; PR opened", "final assistant text threaded back");
  assert(restoredOnResume === snapshot && !restoredOnResume.includes("PARTIAL-GARBAGE"), "the crash's partial JSONL was overwritten by the snapshot before --resume");
  assert(cps[1]?.modelInvocation?.costUsd === 0.019, "turn 2 cost captured (per-turn accounting across resume)");

  // --- Mid-invocation budget kill ---
  console.log("\nBudget kill (runaway single invocation):");
  const killScript: Script = async ({ argv, onData, signal }) => {
    const sid = sessionId(argv);
    emit(onData, { type: "system", subtype: "init", session_id: sid });
    emit(onData, { type: "assistant", message: { content: [{ type: "text", text: "…" }], usage: { input_tokens: 5_000_000, output_tokens: 0 } } });
    await new Promise<void>((_r, rej) => {
      if (signal?.aborted) return rej(new Error("aborted"));
      signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
    return { exitCode: 0 };
  };
  const killRuntime = new ClaudeCodeAgentRuntime({
    secrets: new EnvSecretStore({}),
    registry,
    socketDir,
    sandbox: fakeSandbox(killScript, ws).sandbox,
    governed: { gateway: gov.gateway, tools: gov.tools },
    proxy: { baseUrl: "http://proxy.internal:8080" },
    getRemainingBudgetUsd: () => 0.0001,
  });
  let killed = false;
  try {
    await killRuntime.nextTurn({ request: { ...request, taskId: "k7-runaway" }, checkpoint: { completedSteps: [], findings: [] } as never, workspace: ws, onTurnCheckpoint: () => {} });
  } catch (err) {
    killed = /budget exceeded mid-invocation/.test(String(err));
  }
  assert(killed, "the runaway invocation was killed when streamed usage breached the remaining budget");

  console.log("\nK7 demo PASSED — the loop runs identically on the Claude Code harness.");
  process.exit(0);
}

/** Ensure the session file's parent dir exists; return an opening user line. */
function ensureDir(sessPath: string): string {
  mkdirSync(dirname(sessPath), { recursive: true });
  return `${JSON.stringify({ role: "user", content: "implement the plan" })}\n`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
