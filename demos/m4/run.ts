/**
 * M4 automated demo (roadmap.md M4 exit criteria).
 *
 * Feeds a recorded Slack app_mention through the Slack surface (signature verify
 * + dedupe) into the Invocation Router; a durable task runs a read tool and the
 * structured result is delivered as a threaded reply via a FAKE Slack client.
 * A 👍 reaction is captured as feedback. A replayed duplicate event is a no-op.
 *
 * Deterministic — no network/keys. The real Slack path is verified locally via
 * `make smoke-slack`. Requires Postgres at DATABASE_URL.
 */
import { EnvSecretStore } from "@marathon/config";
import { Database, migrate } from "@marathon/db";
import { type StructuredResult, type AgentDescriptor } from "@marathon/surface";
import {
  computeSlackSignature,
  FakeSlackClient,
  parseAppMention,
  parseReactionFeedback,
  SlackDelivery,
  verifySlackSignature,
} from "@marathon/surface-slack";
import { Queue } from "@marathon/queue";
// We build a small inline step runner that uses a read tool, so the task
// genuinely "runs read tools" before responding.
import { InvocationRouter, Orchestrator, parseCheckpoint, Worker } from "@marathon/worker";
import { makeCliTool, ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const SIGNING_SECRET = "demo-signing-secret";

async function main(): Promise<void> {
  const applied = await migrate();
  console.log(`[m4] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon");
  const queue = new Queue(process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon");

  try {
    const tenant = await db.createTenant({ name: `demo-m4-${Date.now()}` });
    const bruce = await db.createAgent({ tenantId: tenant.id, name: "bruce" });
    const agents: AgentDescriptor[] = [{ name: "bruce", keywords: ["error", "deploy", "incident"] }];

    const orchestrator = new Orchestrator(db, queue);
    const router = new InvocationRouter(db, orchestrator);

    // --- 1. inbound Slack event: verify signature + dedupe + parse ---
    const eventId = "Ev0M4DEMO";
    const rawEvent = {
      type: "app_mention" as const,
      user: "U_TANTON",
      channel: "C_ENG",
      ts: "1700000000.000100",
      team: "T_TANTON",
      text: "<@U_BOT> bruce why did checkout errors spike?",
    };
    const body = JSON.stringify({ event: rawEvent, event_id: eventId });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(SIGNING_SECRET, timestamp, body);
    assert(verifySlackSignature(SIGNING_SECRET, timestamp, body, signature), "signature must verify");

    // dedupe inbound events by event id
    const firstSeen = await db.claim(`slack:event:${eventId}`);
    assert(firstSeen, "first event should be newly seen");

    const invocation = parseAppMention(rawEvent, { knownAgents: ["bruce"], eventId });
    assert(invocation.agentName === "bruce", "should resolve agent bruce");

    // --- 2. route -> durable task ---
    const routed = await router.route(invocation, {
      tenantId: tenant.id,
      agents,
      agentIdByName: { bruce: bruce.id },
      defaultAgent: "bruce",
    });
    assert(!routed.deduped, "first route should not be deduped");
    console.log(`[m4] routed Slack mention -> task ${routed.task.id} (agent ${routed.agentName})`);

    // --- 3. worker runs the task: use a read tool, then respond ---
    const gateway = new ToolGateway({
      registry: new ToolRegistry([makeCliTool(["echo"])]),
      policy: { grants: [{ tool: "cli.run" }] } as ToolPolicy,
      secrets: new EnvSecretStore({}),
      recorder: {
        onInvocation: (r) =>
          db.recordToolInvocation({
            taskId: r.taskId,
            toolId: r.toolName,
            status: r.status,
            riskLevel: r.riskLevel,
            inputSummary: r.inputSummary,
            outputSummary: r.outputSummary,
            error: r.error,
          }),
        onAudit: (e) =>
          void db.write({ tenantId: e.tenantId, eventType: e.eventType, summary: e.summary, targetType: e.targetType, targetId: e.targetId }),
      },
    });

    const stepRunner = async ({ checkpoint }: { checkpoint: { completedSteps: string[]; findings: string[] } }) => {
      const i = checkpoint.completedSteps.length;
      if (i === 0) {
        const out = await gateway.run(
          "cli.run",
          { command: "echo found-deploy-at-0942" },
          { taskId: routed.task.id, tenantId: tenant.id, agentId: bruce.id },
        );
        return {
          stepType: "tool:cli.run",
          checkpoint: { completedSteps: ["tool:cli.run"], findings: [out.content.trim()] },
          done: false,
        };
      }
      return {
        stepType: "respond",
        checkpoint: {
          completedSteps: [...checkpoint.completedSteps, "respond"],
          findings: [...checkpoint.findings, "Likely cause: PR #4812 (payment retry null path)"],
        },
        done: true,
      };
    };

    const worker = new Worker(queue, db, { stepRunner, visibilityMs: 10_000 });
    await worker.drain();

    const finalTask = await db.getTask(routed.task.id);
    assert(finalTask!.status === "completed", `task should complete, got ${finalTask!.status}`);
    assert((await db.countToolInvocations(routed.task.id)) >= 1, "task should have run a read tool");

    // --- 4. deliver structured result as a threaded Slack reply (fake client) ---
    const slack = new FakeSlackClient();
    const delivery = new SlackDelivery(slack);
    const cp = parseCheckpoint(finalTask!.checkpoint);
    const result: StructuredResult = {
      summary: cp.findings.at(-1) ?? "(no result)",
      evidence: cp.findings.slice(0, -1),
      costUsd: 0,
    };
    await delivery.deliverResult(invocation.sourceRef, result);
    assert(slack.messages.length === 1, "should post one threaded reply");
    assert(slack.messages[0]!.threadTs === "1700000000.000100", "reply should be in-thread");
    assert(slack.messages[0]!.text.includes("PR #4812"), "reply should contain the answer");
    console.log(`[m4] delivered threaded reply: "${slack.messages[0]!.text.split("\n")[0]}"`);

    // --- 5. feedback: 👍 reaction -> Feedback row ---
    const fb = parseReactionFeedback({ type: "reaction_added", user: "U_TANTON", reaction: "+1", item: { ts: slack.messages[0]!.ts } });
    assert(fb?.feedbackType === "thumbs_up", "reaction should map to thumbs_up");
    const fbUser = await db.findOrCreateUserByIdentity(tenant.id, "slack", "U_TANTON");
    await db.recordFeedback({ tenantId: tenant.id, taskId: routed.task.id, agentId: bruce.id, userId: fbUser.id, feedbackType: fb!.feedbackType });
    assert((await db.countFeedback(tenant.id)) === 1, "feedback should be recorded");
    console.log("[m4] captured 👍 feedback");

    // --- 6. duplicate event is a no-op ---
    const seenAgain = await db.claim(`slack:event:${eventId}`);
    assert(!seenAgain, "duplicate event id should be deduped at the gateway");
    const routedAgain = await router.route(invocation, {
      tenantId: tenant.id,
      agents,
      agentIdByName: { bruce: bruce.id },
      defaultAgent: "bruce",
    });
    assert(routedAgain.deduped, "duplicate route should be deduped");
    assert(routedAgain.task.id === routed.task.id, "duplicate should map to the same task");
    assert((await db.countTasks(tenant.id)) === 1, "exactly one task for the event");
    console.log("[m4] duplicate event -> no-op (same task, no double-run)");

    console.log(`[m4] task=${routed.task.id} tools>=1 reply=1 feedback=1 tasks=${await db.countTasks(tenant.id)}`);
    console.log("demo-m4 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-m4 FAILED:", err);
  process.exit(1);
});
