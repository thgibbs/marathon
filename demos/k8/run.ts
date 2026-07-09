/**
 * K8 demo (roadmap §2c; full reference `codex-cli-impl.md` §9/§12): the Codex CLI
 * (headless) harness drives the SAME task pipeline green through the REAL broker,
 * gateway, and container seam — a recorded/fake `codex` CLI (canned
 * `codex exec --json` JSONL) standing in for the model so the demo is
 * deterministic, needs no network, and holds no key. It is the Codex twin of
 * demo-k7 (the Claude Code harness demo) and proves "harnesses are replaceable"
 * (design §28 organ #1) for the third harness.
 *
 * It exercises, end to end:
 *  - governed tools over MCP (§3): the fake CLI talks the real marathon-mcp-shim
 *    handler → ToolBrokerClient → per-task unix socket (auth token) →
 *    serveToolBroker → ToolGateway (validate → policy → redact → audit). Tool
 *    results cross back pre-redacted and a ToolInvocation + audit record land;
 *  - typed refusals preserved (§7.8): a proposed_effect tool comes back as
 *    "[requires proposal] …", not a leaked execution;
 *  - checkpoint + kill/resume with restore-over-partial (§5.2): turn 1 completes
 *    and checkpoints (a `turn-<N>/` snapshot DIR of the sessions subtree); a
 *    simulated crash scribbles partial state into the live `$CODEX_HOME` sessions
 *    subtree; turn 2 RESUMES with `resume <session-id>`, and the runtime restores
 *    the snapshot OVER the partial before the CLI runs;
 *  - config hygiene (§3.1): the atomically-written `$CODEX_HOME/config.toml`
 *    carries `required = true`, `startup_timeout_sec`, the pre-approved
 *    marathon MCP server, the persona in `developer_instructions`, and the
 *    `[projects."/workspace"] trust_level = "untrusted"` pin — and the atomic
 *    write leaves the session subtree beside it intact;
 *  - key hygiene (§4.1): only `CODEX_API_KEY` (the Marathon spend key) enters the
 *    container env; no other secret material appears in argv;
 *  - cost captured per turn into ModelInvocation (§4.3);
 *  - turn.failed → not-done (§2.2): a scripted failing turn yields done:false and
 *    is retryable from the prior snapshot.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore } from "@marathon/config";
import {
  type AgentContainer,
  CodexAgentRuntime,
  codexConfigHostPath,
  codexSessionHostPath,
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

// Codex pins the OpenAI provider (§4.3); use a real OpenAI model ref + prices.
const registry = new ModelRegistry([{ provider: "openai", model: "gpt-5-codex", cost: { input: 3, output: 15 } }]);

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

/** Read the per-turn broker connect target (socket + capability token) out of the config.toml the runtime wrote (§3.1). */
function brokerTargetFromConfig(workspaceDir: string): { token?: string } {
  const toml = readFileSync(codexConfigHostPath({ workspaceDir }), "utf8");
  const argsLine = toml.split("\n").find((l) => l.startsWith("args ="))!;
  const args: string[] = JSON.parse(argsLine.slice(argsLine.indexOf("[")));
  const i = args.indexOf("--token");
  return { token: i >= 0 ? args[i + 1] : undefined };
}

/** A broker client wrapped as the shim's BrokerLike, so the demo runs the REAL MCP handler. */
async function connectShimBroker(socketPath: string, token?: string) {
  const conn = connect(socketPath);
  await new Promise<void>((res, rej) => {
    conn.once("connect", res);
    conn.once("error", rej);
  });
  // Present the per-turn capability token before any tool is served (§3.1).
  if (token) conn.write(`${JSON.stringify({ auth: token })}\n`);
  const client = new ToolBrokerClient(conn, conn);
  const broker = {
    listTools: () => client.listTools(),
    request: (req: { tool: string; input: Record<string, unknown> }) => client.request(req),
  };
  return { conn, broker };
}

/** Call a governed tool exactly as Codex would: an MCP tools/call through the shim. */
async function mcpCall(broker: Parameters<typeof handleMcpRequest>[0], name: string): Promise<string> {
  const resp = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const content = (resp?.result as { content: { text: string }[] }).content;
  return content[0]?.text ?? "";
}

/** The Codex session id being resumed: `resume <sid>` right after `exec` (§2.1); undefined on the first turn. */
function resumeIdFrom(argv: string[]): string | undefined {
  const i = argv.indexOf("resume");
  return i >= 0 ? argv[i + 1] : undefined;
}

function emit(onData: (b: Buffer) => void, ev: unknown): void {
  onData(Buffer.from(`${JSON.stringify(ev)}\n`));
}

/** Write session/rollout state under $CODEX_HOME/sessions (what the real CLI persists, §5.2). */
function writeSession(workspaceDir: string, body: string): string {
  const dir = codexSessionHostPath({ workspaceDir });
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "rollout.jsonl");
  writeFileSync(p, body);
  return p;
}
function readRollout(workspaceDir: string): string | undefined {
  const p = join(codexSessionHostPath({ workspaceDir }), "rollout.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
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
  const seen: { env?: Record<string, string>; argv?: string[] } = {};
  const sandbox = {
    createContainer: (_r: unknown, _w: AgentWorkspaceBinding | undefined, extra?: { mounts?: { source: string; target: string }[] }) => {
      const socketPath = extra?.mounts?.find((m) => m.target === GUEST_BROKER_SOCKET)?.source ?? "";
      const c: AgentContainer = {
        async start() {},
        async stop() {},
        async execStream(argv, opts = {}) {
          seen.argv = argv;
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
  console.log("K8 demo — Codex CLI harness through the real broker/gateway (fake CLI)\n");
  const ws: AgentWorkspaceBinding = { dir: mkdtempSync(join(tmpdir(), "k8ws-")), baseSha: "base-sha" };
  const sessionDir = mkdtempSync(join(tmpdir(), "k8sess-"));
  const socketDir = mkdtempSync(join(tmpdir(), "k8sock-"));
  const gov = governed();

  let refusalSeen = "";
  let restoredOnResume: string | undefined;
  let restoredSessionsIntactAfterConfig = false;

  const script: Script = async ({ argv, onData, socketPath, workspaceDir }) => {
    const resumeSid = resumeIdFrom(argv);

    if (!resumeSid) {
      // Turn 1: Codex mints its own id, reported via thread.started (§2.2).
      const sid = "th-minted-001";
      // Mid-turn: perform a real governed tool call + a proposed-effect attempt
      // through the shim → broker socket → gateway.
      const { conn, broker } = await connectShimBroker(socketPath, brokerTargetFromConfig(workspaceDir).token);
      const read = await mcpCall(broker, "github_read_file");
      refusalSeen = await mcpCall(broker, "doc_delete");
      conn.destroy();
      // The config write happened BEFORE the CLI ran; the session subtree beside
      // config.toml must be untouched by that atomic write — assert it's empty now.
      restoredSessionsIntactAfterConfig = readRollout(workspaceDir) === undefined;
      writeSession(workspaceDir, `${JSON.stringify({ role: "assistant", content: read })}\n`);
      emit(onData, { type: "thread.started", thread_id: sid });
      emit(onData, { type: "turn.started" });
      emit(onData, { type: "item.completed", item: { item_type: "mcp_tool_call", tool: "github_read_file" } });
      emit(onData, { type: "turn.completed", agent_message: `read: ${read}`, usage: { input_tokens: 200, output_tokens: 30 } });
      return { exitCode: 0 };
    }

    // Turn 2 (resume): the runtime restored the snapshot subtree over the crash's
    // partial BEFORE we ran. Capture what we see, then complete.
    restoredOnResume = readRollout(workspaceDir);
    writeSession(workspaceDir, `${restoredOnResume ?? ""}${JSON.stringify({ role: "assistant", content: "implemented; PR opened" })}\n`);
    emit(onData, { type: "thread.started", thread_id: resumeSid });
    emit(onData, { type: "item.completed", item: { item_type: "agent_message", text: "done" } });
    emit(onData, { type: "turn.completed", agent_message: "implemented; PR opened", usage: { input_tokens: 80, output_tokens: 20 } });
    return { exitCode: 0 };
  };

  const { sandbox, seen } = fakeSandbox(script, ws);
  const runtime = new CodexAgentRuntime({
    // secret/openai-codex → OPENAI_CODEX (EnvSecretStore convention). A fake key.
    secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon-fake" }),
    registry,
    sessionDir,
    socketDir,
    sandbox,
    governed: { gateway: gov.gateway, tools: gov.tools },
  });

  const request = { taskId: "k8-task", instructions: "You are Forge.", input: "implement the plan", modelRef: "openai:gpt-5-codex", tenantId: "tn1", agentId: "ag1" };

  // --- Turn 1: governed tools + typed refusal + checkpoint ---
  console.log("Turn 1 (governed tools over MCP + checkpoint):");
  const cps: AgentTurnCheckpoint[] = [];
  const t1 = await runtime.nextTurn({
    request,
    checkpoint: { completedSteps: [], findings: [] } as never,
    workspace: ws,
    onTurnCheckpoint: (cp) => void cps.push(cp),
  });
  assert(t1.done === true, "turn 1 completed (turn.completed → done)");
  assert(t1.text === "read: export const answer = 42;", "the redacted governed-tool output threaded back into the final message");
  assert(gov.invocations.some((r) => r.toolName === "github.read_file" && r.status === "ok"), "github.read_file ran through the gateway and was audited");
  assert(gov.audits.some((a) => `${a.eventType} ${a.summary}`.includes("github.read_file")), "an audit record was written for the governed call");
  assert(refusalSeen.startsWith("[requires proposal]"), "doc.delete came back as a typed proposed-effect refusal, not an execution");
  assert(!gov.invocations.some((r) => r.toolName === "doc.delete" && r.status === "ok"), "the proposed-effect tool never executed");
  assert(cps[0]?.modelInvocation?.provider === "openai", "the turn's ModelInvocation pins the OpenAI provider");
  assert(cps[0]?.modelInvocation?.costUsd != null && Math.abs(cps[0]!.modelInvocation!.costUsd! - (200 * 3 + 30 * 15) / 1_000_000) < 1e-12, "turn 1 cost captured from turn.completed usage onto the checkpoint");

  // --- Key hygiene: only CODEX_API_KEY entered the env; nothing secret in argv ---
  console.log("\nKey hygiene (direct-mode CODEX_API_KEY, §4.1):");
  assert(seen.env?.CODEX_API_KEY === "sk-openai-marathon-fake", "the Marathon spend key entered the container env as CODEX_API_KEY");
  assert(seen.env?.CODEX_HOME === "/workspace/.marathon-home/.codex", "CODEX_HOME points at the workspace-home codex dir");
  assert(!(seen.argv ?? []).join(" ").includes("sk-openai"), "no secret material appears in the codex argv");

  // --- Config hygiene: the atomically-written config.toml (§3.1) ---
  console.log("\nConfig hygiene (atomic per-turn config.toml, §3.1):");
  const toml = readFileSync(codexConfigHostPath({ workspaceDir: ws.dir }), "utf8");
  assert(/required = true/.test(toml), "the marathon MCP server is required = true (a wedged shim fails the invocation, §4.2)");
  assert(/startup_timeout_sec = \d+/.test(toml), "startup_timeout_sec bounds the shim handshake");
  assert(/default_tools_approval_mode = "approve"/.test(toml), "the marathon MCP server is pre-approved (§3.3)");
  assert(/\[projects\."\/workspace"\]/.test(toml) && /trust_level = "untrusted"/.test(toml), "the workspace is pinned trust_level = untrusted (no repo-local .codex/ layer loads, §3.1)");
  assert(/developer_instructions = "You are Forge\."/.test(toml), "developer_instructions carries the persona (§2.4)");
  assert(restoredSessionsIntactAfterConfig, "the atomic config write left the sessions subtree beside it untouched (§3.1)");

  // --- Turn 1 checkpoint: the snapshot DIR of the sessions subtree ---
  console.log("\nCheckpoint (session snapshot DIR, §5.2):");
  const ref = decodeSessionRef(t1.sessionRef)!;
  assert(ref.sessionId === "th-minted-001", "the sessionRef decodes to the minted Codex session id");
  assert(ref.snapshot != null && existsSync(ref.snapshot), "the snapshot path exists");
  assert(/[/\\]turn-\d+$/.test(ref.snapshot!), "the snapshot is a per-turn directory (turn-<N>/) under sessionDir/<taskId>");
  assert(readdirSync(sessionDir).includes("k8-task") && existsSync(join(sessionDir, "k8-task", "turn-0")), "the snapshot dir turn-0/ exists under sessionDir/<taskId>");
  const snapshot = readFileSync(join(ref.snapshot!, "rollout.jsonl"), "utf8");

  // --- Simulate a crash: scribble a partial file into the LIVE sessions subtree ---
  writeSession(ws.dir, "PARTIAL-GARBAGE-FROM-CRASH\n");

  // --- Turn 2: resume; snapshot restored OVER the partial, argv uses `resume <sid>` ---
  console.log("\nTurn 2 (resume; snapshot restored over the partial, §5.2):");
  const t2 = await runtime.nextTurn({
    request,
    checkpoint: { completedSteps: ["turn:0"], findings: [], sessionRef: t1.sessionRef, turnIndex: 0 } as never,
    workspace: ws,
    onTurnCheckpoint: (cp) => void cps.push(cp),
  });
  assert(resumeIdFrom(seen.argv ?? []) === ref.sessionId, "the resume argv carried `resume <session-id>` (§2.1)");
  assert(t2.done === true, "turn 2 completes the run (turn.completed)");
  assert(t2.text === "implemented; PR opened", "final assistant text threaded back");
  assert(restoredOnResume === snapshot && !restoredOnResume.includes("PARTIAL-GARBAGE"), "the crash's partial rollout was overwritten by the snapshot before resume ran");
  assert(cps[1]?.modelInvocation != null && Math.abs(cps[1]!.modelInvocation!.costUsd! - (80 * 3 + 20 * 15) / 1_000_000) < 1e-12, "turn 2 cost captured (per-turn accounting across resume)");

  // --- turn.failed → not-done, retryable from the prior snapshot ---
  console.log("\nturn.failed → not-done (§2.2):");
  const failScript: Script = async ({ argv, onData }) => {
    emit(onData, { type: "thread.started", thread_id: resumeIdFrom(argv) ?? "th-fail" });
    emit(onData, { type: "turn.failed", error: { message: "model overloaded" } });
    return { exitCode: 0 };
  };
  const failRuntime = new CodexAgentRuntime({
    secrets: new EnvSecretStore({ OPENAI_CODEX: "sk-openai-marathon-fake" }),
    registry,
    sessionDir,
    socketDir,
    sandbox: fakeSandbox(failScript, ws).sandbox,
    governed: { gateway: gov.gateway, tools: gov.tools },
  });
  let failed = "";
  try {
    await failRuntime.nextTurn({
      request: { ...request, taskId: "k8-fail" },
      checkpoint: { completedSteps: ["turn:0"], findings: [], sessionRef: t1.sessionRef, turnIndex: 0 } as never,
      workspace: ws,
      onTurnCheckpoint: () => {},
    });
  } catch (err) {
    failed = String(err);
  }
  assert(/codex turn failed: model overloaded/.test(failed), "a turn.failed surfaces as a not-done error the step runner retries from the last snapshot");
  // The prior snapshot is untouched by the failed turn — still resumable.
  assert(existsSync(join(ref.snapshot!, "rollout.jsonl")), "the prior turn-0 snapshot survives the failed turn (retryable from it)");

  console.log("\nK8 demo PASSED — the loop runs identically on the Codex CLI harness.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
