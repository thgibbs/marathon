/**
 * M5.5 automated demo (roadmap.md M5.5 exit criteria).
 *
 * Drives the live Slack app's dispatcher with RECORDED Socket Mode envelopes and
 * a FAKE agent + FAKE Slack client (deterministic — no network/keys):
 *   - an app_mention -> durable task -> agent run -> threaded reply (ack + result)
 *   - a 👍 reaction  -> feedback recorded
 *   - a duplicate envelope (same event id) -> no-op
 *
 * Requires Postgres at DATABASE_URL.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { bootstrapSlackApp, dispatchEnvelope, type AppDeps } from "@marathon/slack-app";
import { FakeSlackClient, SlackDelivery, type SocketEnvelope } from "@marathon/surface-slack";
import { InvocationRouter, makeAgentTaskStepRunner, Orchestrator, Worker } from "@marathon/worker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function mentionEnvelope(eventId: string, text: string): SocketEnvelope {
  return {
    type: "events_api",
    envelope_id: `env-${eventId}`,
    payload: {
      event_id: eventId,
      team_id: "T_DEMO",
      event: { type: "app_mention", user: "U_TANTON", channel: "C_GENERAL", ts: "1700000000.000100", text },
    },
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[slack-app demo] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  const queue = new Queue(url);
  try {
    const boot = await bootstrapSlackApp(db, { teamId: `T_DEMO_${Date.now()}`, teamName: "Demo" });

    const runtime = new FakeAgentRuntime({ turns: [{ text: "Likely cause: PR #4812 (payment retry null path)" }] });
    const worker = new Worker(queue, db, {
      stepRunner: makeAgentTaskStepRunner(db, runtime, { modelRef: "openai:gpt-4o-mini" }),
      visibilityMs: 10_000,
    });
    const slack = new FakeSlackClient();
    const deps: AppDeps = {
      db,
      router: new InvocationRouter(db, new Orchestrator(db, queue)),
      worker,
      delivery: new SlackDelivery(slack),
      tenantId: boot.tenantId,
      agents: boot.agents,
      agentIdByName: boot.agentIdByName,
      defaultAgent: boot.defaultAgent,
    };

    // 1. app_mention -> task -> reply  (unique event id per run; CI DB is fresh, dev DB persists)
    const eventId = `Ev-${Date.now()}`;
    await dispatchEnvelope(deps, mentionEnvelope(eventId, "<@U0BOT> bruce why did checkout errors spike?"));
    assert(slack.messages.length === 2, `expected ack + result (2 messages), got ${slack.messages.length}`);
    assert(slack.messages.every((m) => m.threadTs === "1700000000.000100"), "replies should be threaded");
    assert(slack.messages[1]!.text.includes("PR #4812"), "result should contain the agent's answer");
    assert((await db.countTasks(boot.tenantId)) === 1, "one task created");
    console.log(`[slack-app demo] mention -> threaded reply: "${slack.messages[1]!.text.split("\n")[0]}"`);

    // 2. reaction -> feedback
    await dispatchEnvelope(deps, {
      type: "events_api",
      payload: { event: { type: "reaction_added", user: "U_TANTON", reaction: "+1", item: { ts: slack.messages[1]!.ts } } },
    });
    assert((await db.countFeedback(boot.tenantId)) === 1, "feedback recorded");
    console.log("[slack-app demo] 👍 reaction -> feedback recorded");

    // 3. duplicate envelope -> no-op
    await dispatchEnvelope(deps, mentionEnvelope(eventId, "<@U0BOT> bruce why did checkout errors spike?"));
    assert(slack.messages.length === 2, "duplicate event must not post again");
    assert((await db.countTasks(boot.tenantId)) === 1, "duplicate event must not create a task");
    console.log("[slack-app demo] duplicate envelope -> no-op");

    console.log("demo-slack-app OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-slack-app FAILED:", err);
  process.exit(1);
});
