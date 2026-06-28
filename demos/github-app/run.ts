/**
 * M6.2 automated demo — the live document app's webhook receiver, deterministic.
 *
 * Feeds SIGNED GitHub webhook payloads through handleWebhookRequest (signature
 * verify + delivery-id dedupe) into the same pipeline as the live server, with a
 * fake agent + fixtures GitHub client:
 *   - issue_comment mention -> draft a design-doc PR + reply (task waits)
 *   - merged pull_request -> execute + comment
 *   - duplicate delivery -> 200 (no double-run); bad signature -> 401
 *
 * Requires Postgres at DATABASE_URL.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, GithubDelivery, makeDocumentTools } from "@marathon/connector-github";
import { Database, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, type GithubAppDeps } from "@marathon/github-app";
import { Queue } from "@marathon/queue";
import { computeGithubSignature } from "@marathon/surface-github";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { InvocationRouter, Orchestrator } from "@marathon/worker";

const SECRET = "demo-webhook-secret";
const REPO = "thgibbs/agentp-demo";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function signed(eventType: string, deliveryId: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return { eventType, deliveryId, rawBody, signature: computeGithubSignature(SECRET, rawBody) };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[github-app demo] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  const queue = new Queue(url);
  try {
    const boot = await bootstrapGithubApp(db, { owner: `demo-owner-${Date.now()}` });
    // "thgibbs" defaults to write access; "stranger" is denied.
    const gh = new FixturesGithubClient({ userPermissions: { [`${REPO}:stranger`]: "none" } });
    const deps: GithubAppDeps = {
      db,
      client: gh,
      router: new InvocationRouter(db, new Orchestrator(db, queue)),
      gateway: new ToolGateway({
        registry: new ToolRegistry(makeDocumentTools(() => gh)),
        policy: { grants: [{ tool: "document.create" }, { tool: "document.comment" }] } as ToolPolicy,
        secrets: new EnvSecretStore({}),
        recorder: {
          onInvocation: (r) => db.recordToolInvocation({ taskId: r.taskId, toolId: r.toolName, status: r.status, riskLevel: r.riskLevel, inputSummary: r.inputSummary, outputSummary: r.outputSummary, error: r.error }),
          onAudit: (e) => db.write({ tenantId: e.tenantId, eventType: e.eventType, summary: e.summary, targetType: e.targetType, targetId: e.targetId }),
        },
      }),
      delivery: new GithubDelivery(gh),
      runtime: new FakeAgentRuntime({ turns: [{ text: "# Rate limiting design\n\n- token bucket per key" }] }),
      tenantId: boot.tenantId,
      agents: boot.agents,
      agentIdByName: boot.agentIdByName,
      defaultAgent: boot.defaultAgent,
    };

    // Unique ids per run (delivery-id dedupe + router idempotency) so re-runs on a
    // persistent dev DB don't dedupe to a prior run. CI's DB is ephemeral.
    const u = Date.now();

    // 1. mention webhook -> draft a doc PR + reply
    const mention = signed("issue_comment", `d-mention-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 20 },
      comment: { id: u, body: "@marathon quill draft a plan for rate limiting", user: { login: "thgibbs" } },
    });
    const r1 = await handleWebhookRequest(deps, SECRET, mention);
    assert(r1.status === 200, `mention webhook should 200, got ${r1.status}`);
    assert(gh.writes.some((w) => w.op === "createPullRequest"), "a design-doc PR should be opened");
    assert((await db.countDocumentArtifacts(boot.tenantId)) === 1, "a document artifact should be recorded");
    console.log("[github-app demo] issue_comment mention -> drafted design-doc PR + reply");

    // 2. bad signature -> 401
    const bad = await handleWebhookRequest(deps, SECRET, { eventType: "issue_comment", deliveryId: "d-x", rawBody: mention.rawBody, signature: "sha256=bad" });
    assert(bad.status === 401, "bad signature should be 401");

    // 3. duplicate delivery -> 200 no-op
    const dup = await handleWebhookRequest(deps, SECRET, mention);
    assert(dup.status === 200 && dup.note === "duplicate delivery", "duplicate delivery should be a no-op");
    assert(gh.writes.filter((w) => w.op === "createPullRequest").length === 1, "no second PR on duplicate");
    console.log("[github-app demo] bad signature -> 401; duplicate delivery -> no-op");

    // 4. merge webhook -> execute (PR #1 from the fixtures client)
    const merge = signed("pull_request", `d-merge-${u}`, {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: { number: 1, merged: true, merge_commit_sha: "abc123" },
    });
    const r2 = await handleWebhookRequest(deps, SECRET, merge);
    assert(r2.status === 200, "merge webhook should 200");
    const artifact = await db.findDocumentArtifactByPr(boot.tenantId, REPO, 1);
    assert(artifact?.owningTaskId != null, "merge should resolve to the producing task");
    assert((await db.getTask(artifact!.owningTaskId!))!.status === "completed", "merged task should complete");
    const comments = gh.writes.filter((w) => w.op === "commentIssue").length;
    assert(comments >= 3, `expected >=3 comments (ack? draft reply, progress, result), got ${comments}`);
    console.log("[github-app demo] merged PR -> executed + commented");

    // 5. mention from a user WITHOUT repo access -> denied (no PR, no task)
    const prCountBefore = gh.writes.filter((w) => w.op === "createPullRequest").length;
    const tasksBefore = await db.countTasks(boot.tenantId);
    const denied = signed("issue_comment", `d-denied-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 21 },
      comment: { id: u + 1, body: "@marathon quill draft something", user: { login: "stranger" } },
    });
    const r3 = await handleWebhookRequest(deps, SECRET, denied);
    assert(r3.status === 200, "denied mention still returns 200");
    assert(gh.writes.filter((w) => w.op === "createPullRequest").length === prCountBefore, "no PR for a user without access");
    assert((await db.countTasks(boot.tenantId)) === tasksBefore, "no task for a user without access");
    console.log("[github-app demo] mention from user without repo access -> denied (no PR/task)");

    console.log(`[github-app demo] artifacts=${await db.countDocumentArtifacts(boot.tenantId)} comments=${comments}`);
    console.log("demo-github-app OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-github-app FAILED:", err);
  process.exit(1);
});
