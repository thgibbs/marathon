/**
 * demo-k5 (roadmap K5; code-migration.md Tracks 16-17): status + cost
 * visibility — `@agent status` answers with the §15.3 view (headline, current
 * step, completed steps, waiting state, PR link), and every final result
 * carries the silent cost footer (§13.3).
 *
 *   make demo-k5        (requires Postgres at DATABASE_URL)
 *
 * Proves, with a fake agent/Slack through the real app dispatcher:
 *   1. a finished task's final message carries `_cost: $…_` from real
 *      per-turn ModelInvocation records;
 *   2. `status` while the task waits on a question -> "Waiting for your
 *      reply." + the question, without acking/routing new work;
 *   3. `status` after completion -> "Completed." + completed steps + cost;
 *   4. `status` on a BUILD-stage task -> the checkpoint phase and the
 *      delivered PR link;
 *   5. `status` in a thread with no task -> a helpful pointer, no task spawned.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { Database, migrate } from "@marathon/db";
import { getTaskStatus, renderStatusText } from "@marathon/observability";
import { Queue } from "@marathon/queue";
import { bootstrapSlackApp, dispatchEnvelope, type AppDeps } from "@marathon/slack-app";
import { DeliveryFanout } from "@marathon/surface";
import { FakeSlackClient, SlackDelivery, type SocketEnvelope } from "@marathon/surface-slack";
import {
  InvocationRouter,
  makeAgentTaskStepRunner,
  makeWaitingNotifier,
  Orchestrator,
  Worker,
} from "@marathon/worker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function envelope(eventId: string, event: Record<string, unknown>): SocketEnvelope {
  return { type: "events_api", envelope_id: `env-${eventId}`, payload: { event_id: eventId, team_id: "T_K5", event } };
}

// Price turns visibly: 10 in + 5 out tokens of this spec = $2.00 per turn.
const PRICY_SPEC = { provider: "fake", model: "echo", cost: { input: 100_000, output: 200_000 } };

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  await migrate(url);
  const db = new Database(url);
  const queue = new Queue(url);
  const u = Date.now();
  try {
    const boot = await bootstrapSlackApp(db, { teamId: `T_K5_${u}`, teamName: "K5", agents: [{ name: "forge" }] });
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

    // 1. finished task -> the final message carries the silent cost footer.
    const doneThread = "1700000000.000500";
    const doneDeps = makeDeps(new FakeAgentRuntime({ turns: [{ text: "All set." }], spec: PRICY_SPEC }));
    await dispatchEnvelope(doneDeps, envelope(`Ev-k5-done-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: doneThread, text: "<@U0BOT> forge ship it",
    }));
    const finalMsg = slack.messages.at(-1)!;
    assert(finalMsg.text.includes("All set."), "the final answer landed");
    assert(/_cost: \$2\.0000_/.test(finalMsg.text), `final result must carry the cost footer (got: ${finalMsg.text})`);
    console.log("[k5] final result carries the silent cost footer ✓");

    // 2. status while waiting on a clarifying question.
    const waitThread = "1700000000.000501";
    const waitDeps = makeDeps(
      new FakeAgentRuntime({
        turns: [{ text: "Need one thing.", ask: "Which region first?" }, { text: "Rolled out to eu-west." }],
        spec: PRICY_SPEC,
      }),
    );
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-ask-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: waitThread, text: "<@U0BOT> forge roll out the flag",
    }));
    const before = slack.messages.length;
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-status1-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: "1700000000.000502", thread_ts: waitThread, text: "<@U0BOT> forge status",
    }));
    assert(slack.messages.length === before + 1, "status replies with exactly one message (no ack, no new task)");
    const waitingStatus = slack.messages.at(-1)!;
    assert(waitingStatus.text.includes("Waiting for your reply."), `status should say it's waiting (got: ${waitingStatus.text})`);
    assert(waitingStatus.text.includes("Which region first?"), "status should repeat the pending question");
    console.log("[k5] status while parked -> waiting state + the question ✓");

    // 3. answer -> completes; status now renders Completed + steps + cost.
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-answer-${u}`, {
      type: "message", user: "U_TANTON", channel: "C_K5", ts: "1700000000.000503", thread_ts: waitThread, text: "eu-west",
    }));
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-status2-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: "1700000000.000504", thread_ts: waitThread, text: "<@U0BOT> forge status",
    }));
    const doneStatus = slack.messages.at(-1)!;
    assert(doneStatus.text.includes("Completed."), `status should say Completed (got: ${doneStatus.text})`);
    assert(doneStatus.text.includes("- turn:0"), "status lists completed steps");
    assert(/_cost so far: \$4\.0000_/.test(doneStatus.text), `status shows total cost across both turns (got: ${doneStatus.text})`);
    console.log("[k5] status after completion -> Completed + steps + cost ✓");

    // 4. a BUILD-stage task: status renders the checkpoint phase and, once
    // delivery.report_pr recorded it, the PR link (Track 16).
    const buildThread = "1700000000.000505";
    const buildTask = await db.createTask({
      tenantId: boot.tenantId,
      sourceType: "slack",
      sourceRef: { channel: "C_K5", thread_ts: buildThread },
      inputText: "implement the merged plan",
    });
    await db.transitionTask(buildTask.id, "queued");
    await db.transitionTask(buildTask.id, "running");
    await db.completeStep(
      buildTask.id,
      "turn:2",
      { completedSteps: ["turn:0", "turn:1", "turn:2"], findings: [], phase: "build", turnIndex: 2 },
      [{ provider: "fake", model: "echo", inputTokens: 10, outputTokens: 5, costUsd: 1.25, status: "ok" }],
    );
    await db.createCodeChange({
      tenantId: boot.tenantId,
      taskId: buildTask.id,
      repo: "acme/service",
      planRef: { repo: "acme/service", docPath: "docs/plan.md", mergeCommitSha: "abc" },
      baseSha: "abc",
      branch: "marathon/impl-1",
    });
    await db.recordCodeChangeReport(buildTask.id, {
      prNumber: 9,
      prUrl: "https://github.com/acme/service/pull/9",
      branch: "marathon/impl-1",
      state: "submitted_ready",
      verification: [{ command: "pnpm test", exitCode: 0, summary: "ok" }],
    });
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-status3-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: "1700000000.000506", thread_ts: buildThread, text: "<@U0BOT> forge status",
    }));
    const buildStatus = slack.messages.at(-1)!;
    assert(buildStatus.text.includes("Still running."), `BUILD status should be running (got: ${buildStatus.text})`);
    assert(buildStatus.text.includes("Building in the sandbox (turn 3 checkpointed)."), "status renders the BUILD phase");
    assert(buildStatus.text.includes("https://github.com/acme/service/pull/9"), "status shows the delivered PR");
    assert(/_cost so far: \$1\.2500_/.test(buildStatus.text), "status shows the BUILD spend");
    // The same view is what the timeline/API consumers get (getTaskStatus).
    const view = await getTaskStatus(db, boot.tenantId, buildTask.id);
    assert(renderStatusText(view!) === buildStatus.text, "the Slack reply IS the shared §15.3 rendering");
    console.log("[k5] status on a BUILD task -> phase + PR link + spend ✓");

    // 5. status where nothing is running -> a pointer, not a task.
    const tasksBefore = await db.countTasks(boot.tenantId);
    await dispatchEnvelope(waitDeps, envelope(`Ev-k5-status4-${u}`, {
      type: "app_mention", user: "U_TANTON", channel: "C_K5", ts: "1700000000.000507", text: "<@U0BOT> forge status",
    }));
    assert(slack.messages.at(-1)!.text.includes("don't see a task"), "status outside a task thread explains itself");
    assert((await db.countTasks(boot.tenantId)) === tasksBefore, "a status ask never spawns a task");
    console.log("[k5] status outside a task thread -> helpful pointer, no task ✓");

    console.log("demo-k5 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-k5 FAILED:", err);
  process.exit(1);
});
