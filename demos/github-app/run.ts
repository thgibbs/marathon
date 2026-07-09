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
import { FakeAgentRuntime, type AgentTurnContext } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, GithubDelivery, makeDocumentTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, watchDocument, type GithubAppDeps } from "@marathon/github-app";
import { FakeMemoryStore } from "@marathon/memory";
import { Queue } from "@marathon/queue";
import { computeGithubSignature } from "@marathon/surface-github";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { InvocationRouter, makeDocumentPrRecorder, Orchestrator, Worker } from "@marathon/worker";

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
    // §2b #16: doc writes are TOOL calls made by the agent, never handler-
    // committed turn text. The fake turns below call this gateway exactly the
    // way the real agent does; its wiring is load-bearing for the handlers —
    // the docBase pins doc PRs to the plans branch (§29.1a, authoritative),
    // dbToolRecorder backs the post-turn "did a doc write happen" check, and
    // makeDocumentPrRecorder persists the DocumentArtifact + delivery target
    // the approval handler needs.
    const gateway = new ToolGateway({
      registry: new ToolRegistry(
        makeDocumentTools(() => gh, { docBase: "main", onDocumentPr: makeDocumentPrRecorder(db) }),
      ),
      policy: { grants: [{ tool: "document.create" }, { tool: "document.revise" }, { tool: "document.comment" }] } as ToolPolicy,
      secrets: new EnvSecretStore({}),
      recorder: dbToolRecorder(db),
    });
    const govCtx = (ctx: AgentTurnContext) => ({
      taskId: ctx.request.taskId,
      tenantId: ctx.request.tenantId ?? boot.tenantId,
      agentId: ctx.request.agentId,
    });
    const deps: GithubAppDeps = {
      db,
      client: gh,
      memory: new FakeMemoryStore(),
      router: new InvocationRouter(db, orchestrator),
      orchestrator,
      delivery: new GithubDelivery(gh),
      runtime: new FakeAgentRuntime({
        turns: [{
          text: "Drafted the rate-limiting design.",
          act: (ctx) =>
            gateway
              .run("document.create", { repo: REPO, path: "docs/rate-limiting.md", content: "# Rate limiting design\n\n- token bucket per key", title: "Design: rate limiting" }, govCtx(ctx))
              .then(() => {}),
        }],
      }),
      tenantId: boot.tenantId,
      agents: boot.agents,
      agentIdByName: boot.agentIdByName,
      defaultAgent: boot.defaultAgent,
    };
    const u = Date.now(); // unique ids per run (delivery dedupe + router idempotency)

    // 1. mention -> the AGENT drafts a doc PR by calling document.create (§2b #16)
    await handleWebhookRequest(deps, SECRET, signed("issue_comment", `d-mention-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 20 },
      comment: { id: u, body: "@marathon quill draft a plan for rate limiting", user: { login: "thgibbs" } },
    }));
    assert(count(gh, "createPullRequest") === 1, "a design-doc PR should be opened");
    // §29.1a (combined-PR flow): the doc PR is a DRAFT against the default branch.
    const docPr = gh.writes.find((w) => w.op === "createPullRequest")!;
    assert(
      (docPr.args as { base?: string }).base === "main",
      `doc PR must target the default branch (got ${(docPr.args as { base?: string }).base})`,
    );
    assert((docPr.args as { draft?: boolean }).draft === true, "doc PR must open as a DRAFT (§29.1a)");
    assert((await db.countDocumentArtifacts(boot.tenantId)) === 1, "a document artifact should be recorded");
    console.log("[github-app demo] mention -> drafted design-doc PR #1 (draft, against the default branch)");

    // 2. PR comment on PR #1 -> the AGENT revises the doc on its branch by
    //    calling document.revise (no new PR)   [M7 #3, §2b #16]
    deps.runtime = new FakeAgentRuntime({
      turns: [{
        text: "Tightened the limits section.",
        act: async (ctx) => {
          const artifact = await db.findDocumentArtifactByPr(boot.tenantId, REPO, 1);
          const loc = artifact!.location as { path: string; branch: string };
          await gateway.run("document.revise", { repo: REPO, path: loc.path, content: "# Rate limiting design\n\n- tightened limits", branch: loc.branch }, govCtx(ctx));
        },
      }],
    });
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

    // 2c. §2b #11: a SUBMITTED review on the Marathon-drafted doc PR triggers
    //     a revision WITHOUT an @marathon mention — GitHub's batched "now act"
    //     signal. A bot-authored review (CI, or Marathon itself) never does.
    deps.runtime = new FakeAgentRuntime({
      turns: [{
        text: "Addressed the review feedback.",
        act: async (ctx) => {
          const artifact = await db.findDocumentArtifactByPr(boot.tenantId, REPO, 1);
          const loc = artifact!.location as { path: string; branch: string };
          await gateway.run("document.revise", { repo: REPO, path: loc.path, content: "# Rate limiting design\n\n- addressed review", branch: loc.branch }, govCtx(ctx));
        },
      }],
    });
    const putsBeforeReview = count(gh, "putFile");
    // A bot-authored review is ignored (no revision).
    await handleWebhookRequest(deps, SECRET, signed("pull_request_review", `d-botrev-${u}`, {
      action: "submitted",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      pull_request: { number: 1 },
      review: { id: u + 30, state: "changes_requested", body: "automated note", user: { login: "ci[bot]", type: "Bot" } },
    }));
    assert(count(gh, "putFile") === putsBeforeReview, "a bot-authored review must not trigger a revision");
    // A human review requesting changes revises the doc on its branch (no new PR).
    await handleWebhookRequest(deps, SECRET, signed("pull_request_review", `d-review-${u}`, {
      action: "submitted",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      pull_request: { number: 1 },
      review: { id: u + 31, state: "changes_requested", body: "Please tighten the burst allowance.", user: { login: "thgibbs", type: "User" } },
    }));
    assert(count(gh, "createPullRequest") === 1, "a review-triggered revision must NOT open a new PR");
    assert(count(gh, "putFile") === putsBeforeReview + 1, "a submitted review should revise the doc once");
    console.log("[github-app demo] submitted review -> revision (no mention); bot review ignored (§2b #11)");

    // 2b. §2b #16: a turn that makes NO document tool call commits NOTHING and
    //     reports a visible no-op — the model's chat text is never committed.
    deps.runtime = new FakeAgentRuntime({
      turns: [{ text: "That looks like a question, not a doc ask — here is the answer instead." }],
    });
    const prsBeforeNoop = count(gh, "createPullRequest");
    const putsBeforeNoop = count(gh, "putFile");
    await handleWebhookRequest(deps, SECRET, signed("issue_comment", `d-noop-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 22 },
      comment: { id: u + 20, body: "@marathon quill draft what does the limiter do?", user: { login: "thgibbs" } },
    }));
    assert(count(gh, "createPullRequest") === prsBeforeNoop, "a tool-less turn must not open a PR");
    assert(count(gh, "putFile") === putsBeforeNoop, "a tool-less turn must not commit anything");
    assert((await db.countDocumentArtifacts(boot.tenantId)) === 1, "a tool-less turn must not record an artifact");
    const noopReply = gh.writes.filter((w) => w.op === "commentIssue").map((w) => (w.args as { body: string }).body).at(-1)!;
    assert(noopReply.includes("No design document was produced"), `the reply must report the visible no-op (got: ${noopReply.slice(0, 120)})`);
    console.log("[github-app demo] tool-less turn -> visible no-op, nothing committed (§2b #16)");

    // 3. bad signature -> 401
    const bad = await handleWebhookRequest(deps, SECRET, { eventType: "issue_comment", deliveryId: "d-x", rawBody: "{}", signature: "sha256=bad" });
    assert(bad.status === 401, "bad signature should be 401");

    // 4a. §29.1a (combined-PR flow): an APPROVING review on the draft doc PR is
    //     the approval — the doc task completes and a chained implementation
    //     task spawns on the SAME doc branch: plan_ref + base_sha both pin the
    //     approved head SHA, delivery targets are inherited (K2, §29.1a).
    const approvedSha = `head-sha-${u}`;
    const artifact = await db.findDocumentArtifactByPr(boot.tenantId, REPO, 1);
    const docTask = (await db.getTask(artifact!.owningTaskId!))!;
    await handleWebhookRequest(deps, SECRET, signed("pull_request_review", `d-approve-${u}`, {
      action: "submitted",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      pull_request: { number: 1, head: { sha: approvedSha } },
      review: { id: u + 500, state: "approved", user: { login: "thgibbs", type: "User" } },
      sender: { login: "thgibbs" },
    }));
    assert((await db.getTask(docTask.id))!.status === "completed", "approved doc task should complete");
    const implTask = await db.findTaskBySourceTask(docTask.id);
    assert(implTask !== null, "an approving review should spawn an implementation task chained to the doc task");
    const implRef = implTask!.sourceRef as {
      kind?: string;
      baseSha?: string;
      branch?: string;
      planRef?: { approvedSha?: string; docPath?: string };
    };
    assert(
      implRef.kind === "implementation" && implRef.baseSha === approvedSha,
      "implementation task pins base_sha to the approved doc-PR head SHA (§29.1a)",
    );
    assert(implRef.planRef?.approvedSha === approvedSha, "implementation task carries the plan_ref (approved head SHA)");
    assert(typeof implRef.branch === "string" && implRef.branch.length > 0, "implementation task carries the doc branch to push back onto");
    const implTargets = implTask!.deliveryTargets ?? [];
    assert(implTargets.some((t) => t.surfaceType === "github" && t.ref.number === 1), "implementation task inherits the doc PR delivery target");
    assert(implTargets.some((t) => t.ref.number === 20), "implementation task inherits the originating thread target");
    assert(implTask!.status === "queued", "implementation task is queued for the BUILD stage");

    // 4b. re-delivered approval webhook (same head SHA) -> no second task (§29.7)
    await handleWebhookRequest(deps, SECRET, signed("pull_request_review", `d-approve2-${u}`, {
      action: "submitted",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      pull_request: { number: 1, head: { sha: approvedSha } },
      review: { id: u + 500, state: "approved", user: { login: "thgibbs", type: "User" } },
      sender: { login: "thgibbs" },
    }));
    assert((await db.countTasksBySourceTask(docTask.id)) === 1, "webhook re-delivery must not spawn a second implementation task");

    // 4c. merging the combined PR is the SHIP, not the approval: it records the
    //     merge commit but spawns nothing new (§29.1a).
    const mergeSha = `merge-${u}`;
    await handleWebhookRequest(deps, SECRET, signed("pull_request", `d-merge-${u}`, {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: { number: 1, merged: true, merge_commit_sha: mergeSha },
    }));
    assert((await db.countTasksBySourceTask(docTask.id)) === 1, "merging the combined PR must not spawn another implementation task");
    console.log("[github-app demo] bad sig -> 401; approving review -> chained implementation task (idempotent); merge -> ship");

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
