/**
 * demo-k3 (roadmap K3; code-migration.md Track 17): comment/reply iteration
 * continuity — every follow-up lands in the SAME loop instead of starting a
 * new one.
 *
 *   make demo-k3        (requires Postgres at DATABASE_URL)
 *
 * Proves, with fake agents/surfaces through the real apps' dispatchers:
 *   1. Slack: a clarifying question parks the task durably; the thread reply
 *      is the ANSWER and resumes the SAME task to completion;
 *   2. Slack: a reply to a FINISHED loop spawns a continuation task chained to
 *      it (sourceTaskId), same thread, inherited targets;
 *   3. GitHub: a comment on a Marathon doc PR revises the doc on its existing
 *      branch (no new PR);
 *   4. GitHub: a mention on a Marathon-created CODE PR spawns a revision task
 *      pinned to the branch's CURRENT tip (§29.6), briefed to update the same
 *      branch/PR through the brokered git/gh path.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, GithubDelivery, makeDocumentTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, type GithubAppDeps } from "@marathon/github-app";
import { FakeMemoryStore } from "@marathon/memory";
import { Queue } from "@marathon/queue";
import { bootstrapSlackApp, dispatchEnvelope, type AppDeps } from "@marathon/slack-app";
import { DeliveryFanout } from "@marathon/surface";
import { computeGithubSignature } from "@marathon/surface-github";
import { FakeSlackClient, SlackDelivery, type SocketEnvelope } from "@marathon/surface-slack";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import {
  InvocationRouter,
  makeAgentTaskStepRunner,
  makeWaitingNotifier,
  Orchestrator,
  Worker,
} from "@marathon/worker";

const SECRET = "demo-webhook-secret";
const REPO = "thgibbs/agentp-demo";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function signed(eventType: string, deliveryId: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return { eventType, deliveryId, rawBody, signature: computeGithubSignature(SECRET, rawBody) };
}
function envelope(eventId: string, event: Record<string, unknown>): SocketEnvelope {
  return { type: "events_api", envelope_id: `env-${eventId}`, payload: { event_id: eventId, team_id: "T_K3", event } };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  await migrate(url);
  const db = new Database(url);
  const queue = new Queue(url);
  const u = Date.now(); // unique ids per run (event dedupe persists across runs)
  try {
    /* ---------- Slack continuity (Track 12) ---------- */
    const boot = await bootstrapSlackApp(db, {
      teamId: `T_K3_${u}`,
      teamName: "K3",
      agents: [{ name: "forge" }],
    });
    const slack = new FakeSlackClient();
    const delivery = new SlackDelivery(slack);
    const orchestrator = new Orchestrator(db, queue);
    const makeDeps = (runtime: FakeAgentRuntime): AppDeps => ({
      db,
      router: new InvocationRouter(db, orchestrator),
      worker: new Worker(queue, db, {
        stepRunner: makeAgentTaskStepRunner(db, runtime, { modelRef: "fake:echo" }),
        onWaiting: makeWaitingNotifier(db, new DeliveryFanout({ slack: delivery }, db)),
        visibilityMs: 10_000,
      }),
      queue,
      orchestrator,
      delivery,
      tenantId: boot.tenantId,
      agents: boot.agents,
      agentIdByName: boot.agentIdByName,
      defaultAgent: boot.defaultAgent,
    });

    // 1. ask -> clarifying question -> durable wait -> thread reply resumes.
    const thread = "1700000000.000300";
    const askDeps = makeDeps(
      new FakeAgentRuntime({
        turns: [
          { text: "One question first.", ask: "Should rate limits apply per key or per user?" },
          { text: "Done: rate limits are per key, as you answered." },
        ],
      }),
    );
    await dispatchEnvelope(askDeps, envelope(`Ev-k3-ask-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K3", ts: thread, text: "<@U0BOT> forge add rate limiting",
    }));
    const asked = await db.findLatestTaskByThread(boot.tenantId, "C_K3", thread);
    assert(asked?.status === "waiting_for_input", `task should park waiting_for_input (got ${asked?.status})`);
    assert(slack.messages.at(-1)!.text.includes("per key or per user"), "the question was posted in-thread");
    console.log("[k3] Slack ask -> clarifying question -> durable wait ✓");

    await dispatchEnvelope(askDeps, envelope(`Ev-k3-answer-${u}`, {
      type: "message", user: "U_TANTON", channel: "C_K3", ts: "1700000000.000301", thread_ts: thread, text: "per key",
    }));
    const resumed = await db.getTask(asked!.id);
    assert(resumed?.status === "completed", `the reply must resume the SAME task (got ${resumed?.status})`);
    assert(slack.messages.at(-1)!.text.includes("per key"), "the final answer landed in-thread");
    console.log("[k3] thread reply -> resumed the SAME task -> final answer ✓");

    // 2. a reply to the FINISHED loop -> continuation task chained to it.
    const contDeps = makeDeps(new FakeAgentRuntime({ turns: [{ text: "Follow-up done: burst limits added." }] }));
    await dispatchEnvelope(contDeps, envelope(`Ev-k3-cont-${u}`, {
      type: "message", user: "U_TANTON", channel: "C_K3", ts: "1700000000.000302", thread_ts: thread, text: "also add burst limits",
    }));
    const continuation = await db.findLatestTaskByThread(boot.tenantId, "C_K3", thread);
    assert(continuation !== null && continuation.id !== asked!.id, "a NEW task should exist for the follow-up");
    assert(continuation!.sourceTaskId === asked!.id, "the continuation is chained to the finished task");
    assert(continuation!.status === "completed", `continuation should complete (got ${continuation!.status})`);
    assert(slack.messages.at(-1)!.text.includes("burst limits"), "the continuation's answer landed in the same thread");
    console.log("[k3] reply to a finished loop -> chained continuation task ✓");

    /* ---------- GitHub continuity (doc PR + code PR) ---------- */
    const ghBoot = await bootstrapGithubApp(db, {
      owner: `k3-owner-${u}`,
      agents: [{ name: "forge" }],
    });
    const gh = new FixturesGithubClient({});
    const ghOrchestrator = new Orchestrator(db, queue);
    const ghDeps: GithubAppDeps = {
      db,
      client: gh,
      memory: new FakeMemoryStore(),
      router: new InvocationRouter(db, ghOrchestrator),
      orchestrator: ghOrchestrator,
      gateway: new ToolGateway({
        registry: new ToolRegistry(makeDocumentTools(() => gh)),
        policy: { grants: [{ tool: "document.create" }, { tool: "document.revise" }] } as ToolPolicy,
        secrets: new EnvSecretStore({}),
        recorder: dbToolRecorder(db),
      }),
      delivery: new GithubDelivery(gh),
      runtime: new FakeAgentRuntime({ turns: [{ text: "# Rate limiting design\n\n- token bucket per key" }] }),
      tenantId: ghBoot.tenantId,
      agents: ghBoot.agents,
      agentIdByName: ghBoot.agentIdByName,
      defaultAgent: ghBoot.defaultAgent,
    };
    const count = (op: string) => gh.writes.filter((w) => w.op === op).length;

    // 3. mention -> doc PR; then a PR comment -> revise the SAME branch.
    await handleWebhookRequest(ghDeps, SECRET, signed("issue_comment", `k3-draft-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 30 },
      comment: { id: u, body: "@marathon forge draft a plan for rate limiting", user: { login: "thgibbs" } },
    }));
    assert(count("createPullRequest") === 1, "the ask should open a design-doc PR");
    const putsBefore = count("putFile");
    await handleWebhookRequest(ghDeps, SECRET, signed("issue_comment", `k3-revise-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 1, pull_request: {} },
      comment: { id: u + 1, body: "@marathon forge tighten the limits section", user: { login: "thgibbs" } },
    }));
    assert(count("createPullRequest") === 1, "a doc revision must NOT open a new PR");
    assert(count("putFile") === putsBefore + 1, "the revision commits once to the existing doc branch");
    console.log("[k3] doc PR comment -> revised the doc on its branch (no new PR) ✓");

    // 4. a mention on a Marathon-created CODE PR -> revision task pinned to
    // the branch's current tip (§29.6). Seed the delivered code change the
    // BUILD stage would have recorded.
    const implTask = await db.createTask({
      tenantId: ghBoot.tenantId,
      sourceType: "github",
      sourceRef: { kind: "implementation", repo: REPO },
      inputText: "implement the plan",
    });
    const branch = "marathon/impl-rate-limits";
    const planRef = { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: "plan-sha-1" };
    await db.createCodeChange({ tenantId: ghBoot.tenantId, taskId: implTask.id, repo: REPO, planRef, baseSha: "plan-sha-1", branch });
    await db.recordCodeChangeReport(implTask.id, {
      prNumber: 55,
      prUrl: `https://github.com/${REPO}/pull/55`,
      branch,
      state: "submitted_ready",
      verification: [],
    });
    gh.refSha = `tip-sha-${u}`; // the branch has moved since delivery

    await handleWebhookRequest(ghDeps, SECRET, signed("issue_comment", `k3-code-rev-${u}`, {
      action: "created",
      repository: { full_name: REPO, owner: { login: "thgibbs" } },
      issue: { number: 55, pull_request: {} },
      comment: { id: u + 2, body: "@marathon forge please handle the zero-limit edge case", user: { login: "thgibbs" } },
    }));
    const revision = await db.findTaskBySourceTask(implTask.id);
    assert(revision !== null, "the code-PR comment should spawn a revision task chained to the implementation task");
    const ref = revision!.sourceRef as { kind?: string; baseSha?: string; branch?: string };
    assert(ref.kind === "code_revision", `revision task kind should be code_revision (got ${ref.kind})`);
    assert(ref.baseSha === gh.refSha, "the revision is pinned to the branch's CURRENT tip, not the original base");
    assert(ref.branch === branch, "the revision targets the same branch");
    assert(revision!.inputText!.includes("zero-limit"), "the review comment rides in the revision brief");
    assert(
      (revision!.deliveryTargets ?? []).some((t) => t.surfaceType === "github" && t.ref.number === 55),
      "the code PR is a delivery target of the revision",
    );
    console.log("[k3] code PR comment -> revision task pinned to the branch tip ✓");

    // Leave the queue idle for demos sharing this database: the BUILD-stage
    // jobs spawned above are consumed by the BUILD worker in a live deployment.
    const sweeper = new Worker(queue, db, {
      stepRunner: async ({ checkpoint }) => ({ stepType: "noop", done: true, checkpoint }),
    });
    await sweeper.drain();

    console.log("demo-k3 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-k3 FAILED:", err);
  process.exit(1);
});
