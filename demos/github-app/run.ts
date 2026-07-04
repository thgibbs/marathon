/**
 * M6.2 + M7 automated demo — the live document app's webhook receiver, deterministic.
 *
 * Signed GitHub webhooks through handleWebhookRequest (signature + delivery dedupe)
 * into the same pipeline as the live server, with a fake agent + fixtures GitHub +
 * an in-memory MemoryStore:
 *   - issue_comment mention -> draft a design-doc PR + reply
 *   - PR comment on that PR  -> revise the doc on its branch (no new PR)   [M7 #3]
 *   - bad signature -> 401; duplicate delivery -> no-op
 *   - merged pull_request -> execute
 *   - mention from a user without repo access -> denied
 *   - watch a doc + push that changes it -> react (revision bumped, task spawned) [M7 #8]
 *
 * Requires Postgres at DATABASE_URL.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, GithubDelivery, makeDocumentTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, watchDocument, type GithubAppDeps } from "@marathon/github-app";
import { FakeMemoryStore } from "@marathon/memory";
import { Queue } from "@marathon/queue";
import { computeGithubSignature } from "@marathon/surface-github";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { InvocationRouter, Orchestrator, Worker } from "@marathon/worker";

const SECRET = "demo-webhook-secret";
const REPO = "thgibbs/agentp-demo";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function signed(eventType: string, deliveryId: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return { eventType, deliveryId, rawBody, signature: computeGithubSignature(SECRET, rawBody) };
}
const count = (gh: FixturesGithubClient, op: string) => gh.writes.filter((w) => w.op === op).length;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[github-app demo] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  const queue = new Queue(url);
  try {
    // Explicit agent descriptors: this demo scripts its own turns via the
    // Fake runtime (the live app loads YAML specs — Track 14).
    const boot = await bootstrapGithubApp(db, {
      owner: `demo-owner-${Date.now()}`,
      agents: [{ name: "quill", keywords: ["doc", "design", "plan", "draft", "spec"] }],
    });
    const gh = new FixturesGithubClient({ userPermissions: { [`${REPO}:stranger`]: "none" } });
    const orchestrator = new Orchestrator(db, queue);
    const deps: GithubAppDeps = {
      db,
      client: gh,
      memory: new FakeMemoryStore(),
      router: new InvocationRouter(db, orchestrator),
      orchestrator,
      gateway: new ToolGateway({
        registry: new ToolRegistry(makeDocumentTools(() => gh)),
        policy: { grants: [{ tool: "document.create" }, { tool: "document.revise" }, { tool: "document.comment" }] } as ToolPolicy,
        secrets: new EnvSecretStore({}),
        recorder: dbToolRecorder(db),
      }),
      delivery: new GithubDelivery(gh),
      runtime: new FakeAgentRuntime({ turns: [{ text: "# Rate limiting design\n\n- token bucket per key" }] }),
      tenantId: boot.tenantId,
      agents: boot.agents,
      agentIdByName: boot.agentIdByName,
      defaultAgent: boot.defaultAgent,
    };
    const u = Date.now(); // unique ids per run (delivery dedupe + router idempotency)

    // 1. mention -> draft a doc PR
    await handleWebhookRequest(deps, SECRET, signed("issue_comment", `d-mention-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 20 },
      comment: { id: u, body: "@marathon quill draft a plan for rate limiting", user: { login: "thgibbs" } },
    }));
    assert(count(gh, "createPullRequest") === 1, "a design-doc PR should be opened");
    assert((await db.countDocumentArtifacts(boot.tenantId)) === 1, "a document artifact should be recorded");
    console.log("[github-app demo] mention -> drafted design-doc PR #1");

    // 2. PR comment on PR #1 -> revise the doc on its branch (no new PR)   [M7 #3]
    const putsBefore = count(gh, "putFile");
    await handleWebhookRequest(deps, SECRET, signed("issue_comment", `d-rev-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 1, pull_request: {} },
      comment: { id: u + 10, body: "@marathon quill tighten the limits section", user: { login: "thgibbs" } },
    }));
    assert(count(gh, "createPullRequest") === 1, "revision must NOT open a new PR");
    assert(count(gh, "putFile") === putsBefore + 1, "revision should commit once to the existing branch");
    assert(gh.writes.some((w) => w.op === "putFile" && (w.args as { branch?: string }).branch?.startsWith("marathon/doc-")), "revision committed to the draft branch");
    console.log("[github-app demo] PR comment -> revised doc on its branch (no new PR)");

    // 3. bad signature -> 401
    const bad = await handleWebhookRequest(deps, SECRET, { eventType: "issue_comment", deliveryId: "d-x", rawBody: "{}", signature: "sha256=bad" });
    assert(bad.status === 401, "bad signature should be 401");

    // 4. merge PR #1 -> the doc task completes and a chained implementation task
    //    spawns with plan_ref/base_sha + inherited delivery targets (K2, §29.1)
    const mergeSha = `abc123-${u}`;
    await handleWebhookRequest(deps, SECRET, signed("pull_request", `d-merge-${u}`, {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: { number: 1, merged: true, merge_commit_sha: mergeSha },
    }));
    const artifact = await db.findDocumentArtifactByPr(boot.tenantId, REPO, 1);
    const docTask = (await db.getTask(artifact!.owningTaskId!))!;
    assert(docTask.status === "completed", "merged doc task should complete");
    const implTask = await db.findTaskBySourceTask(docTask.id);
    assert(implTask !== null, "merge should spawn an implementation task chained to the doc task");
    const implRef = implTask!.sourceRef as { kind?: string; baseSha?: string; planRef?: { mergeCommitSha?: string; docPath?: string } };
    assert(implRef.kind === "implementation" && implRef.baseSha === mergeSha, "implementation task pins base_sha to the merge commit");
    assert(implRef.planRef?.mergeCommitSha === mergeSha, "implementation task carries the plan_ref");
    const implTargets = implTask!.deliveryTargets ?? [];
    assert(implTargets.some((t) => t.surfaceType === "github" && t.ref.number === 1), "implementation task inherits the doc PR delivery target");
    assert(implTargets.some((t) => t.ref.number === 20), "implementation task inherits the originating thread target");
    assert(implTask!.status === "queued", "implementation task is queued for the BUILD stage");

    // 4b. re-delivered merge webhook -> no second implementation task (§29.7)
    await handleWebhookRequest(deps, SECRET, signed("pull_request", `d-merge2-${u}`, {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: { number: 1, merged: true, merge_commit_sha: mergeSha },
    }));
    assert((await db.countTasksBySourceTask(docTask.id)) === 1, "webhook re-delivery must not spawn a second implementation task");
    console.log("[github-app demo] bad sig -> 401; merged PR -> chained implementation task (idempotent)");

    // This demo scripts the document side only — the live app's BUILD worker
    // (makeBuildWiring, Track 15) is what consumes implementation tasks. Sweep
    // the queued job so other demos sharing this database see an idle queue.
    const sweeper = new Worker(queue, db, {
      stepRunner: async ({ checkpoint }) => ({ stepType: "noop", done: true, checkpoint }),
    });
    await sweeper.drain();

    // 5. mention from a user WITHOUT repo access -> denied (no PR/task)
    const prsBefore = count(gh, "createPullRequest");
    const tasksBefore = await db.countTasks(boot.tenantId);
    await handleWebhookRequest(deps, SECRET, signed("issue_comment", `d-denied-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 21 },
      comment: { id: u + 1, body: "@marathon quill draft something", user: { login: "stranger" } },
    }));
    assert(count(gh, "createPullRequest") === prsBefore, "no PR for a user without access");
    assert((await db.countTasks(boot.tenantId)) === tasksBefore, "no task for a user without access");
    console.log("[github-app demo] user without access -> denied");

    // 6. watch a doc + a push that changes it -> react   [M7 #8]
    await watchDocument(deps, { repo: REPO, path: "docs/policy.md", agentId: boot.agentIdByName.quill });
    const tasksBeforePush = await db.countTasks(boot.tenantId);
    await handleWebhookRequest(deps, SECRET, signed("push", `d-push-${u}`, {
      repository: { full_name: REPO },
      after: "sha-after-001",
      commits: [{ modified: ["docs/policy.md"], added: [] }],
    }));
    const watched = await db.listWatchedArtifacts(boot.tenantId, REPO);
    assert(watched.length === 1 && watched[0]!.lastRevisionSeen === "sha-after-001", "watched doc revision should be bumped to the push sha");
    assert((await db.countTasks(boot.tenantId)) === tasksBeforePush + 1, "a push to a watched doc should spawn a review task");
    console.log("[github-app demo] watched doc + push -> revision bumped + review task spawned");

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
