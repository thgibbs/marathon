/**
 * M2 automated demo (roadmap.md M2 exit criteria).
 *
 * Runs a "hello agent" task through the Agent Worker using a DETERMINISTIC
 * FakeAgentRuntime (no network/keys — the plan's "recorded/mock model provider"):
 *   - agent runs as turns; each turn records a ModelInvocation with cost
 *   - worker #1 runs one turn then CRASHES (abandons its lease)
 *   - worker #2 resumes from the checkpoint and finishes EXACTLY ONCE
 *   - asserts: structured result, model-invocation count == turns, cost > 0
 *
 * Prints "demo-m2 OK"; exits non-zero on failure. Requires Postgres at DATABASE_URL.
 * (The real Pi adapter is exercised separately via `make smoke-pi`.)
 */
import { loadConfig } from "@marathon/config";
import { FakeAgentRuntime } from "@marathon/agent";
import { surfaceEventKey } from "@marathon/core";
import { Database, migrate } from "@marathon/db";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { makeAgentStepRunner, Orchestrator, parseCheckpoint, Worker } from "@marathon/worker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const applied = await migrate(cfg.databaseUrl);
  console.log(`[m2] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  const orchestrator = new Orchestrator(db, queue);

  try {
    const tenant = await db.createTenant({ name: `demo-m2-${Date.now()}` });
    const user = await db.createUser({ tenantId: tenant.id, role: "admin" });
    const agent = await db.createAgent({ tenantId: tenant.id, name: "bruce", ownerUserId: user.id });
    const version = await db.createAgentVersion({
      agentId: agent.id,
      versionNumber: 1,
      instructions: "You are Bruce. Be brief.",
    });

    const idemKey = surfaceEventKey("slack", `evt-${tenant.id}`);
    const { task } = await orchestrator.submit({
      tenantId: tenant.id,
      agentId: agent.id,
      agentVersionId: version.id,
      invokingUserId: user.id,
      sourceType: "slack",
      sourceRef: { channel: "C1", thread_ts: "1.0" },
      inputText: "say hello",
      idempotencyKey: idemKey,
    });
    console.log(`[m2] submitted task ${task.id}`);

    // default model policy (OpenAI) + deterministic fake agent (2 turns)
    const policy = DEFAULT_MODEL_POLICY;
    const runtime = new FakeAgentRuntime({
      turns: [
        { text: "working on it...", inputTokens: 120, outputTokens: 18 },
        { text: "hello from the agent", inputTokens: 60, outputTokens: 12 },
      ],
    });
    const request = {
      taskId: task.id,
      instructions: version.instructions ?? "",
      input: "say hello",
      modelRef: resolveModelRef(policy),
    };
    const stepRunner = makeAgentStepRunner(runtime, request);

    // --- worker #1: one turn, then crash ---
    const visibilityMs = 1000;
    const w1 = new Worker(queue, db, { stepRunner, visibilityMs, crashAfterStepIndex: 0 });
    const o1 = await w1.runOnce();
    assert(o1 === "crashed", `worker #1 expected 'crashed', got '${o1}'`);
    assert((await db.countTaskSteps(task.id)) === 1, "expected 1 step after crash");
    assert((await db.countModelInvocations(task.id)) === 1, "expected 1 model invocation after crash");
    console.log("[m2] worker #1 ran 1 turn (model call recorded), then crashed");

    await sleep(visibilityMs + 500);

    // --- worker #2: resume to completion ---
    const w2 = new Worker(queue, db, { stepRunner, visibilityMs: 10_000 });
    const outcomes = await w2.drain();
    assert(outcomes.includes("completed"), `worker #2 should complete (got ${outcomes.join(",")})`);

    // --- assertions: exactly-once + structured result + cost ---
    const finalTask = await db.getTask(task.id);
    assert(finalTask!.status === "completed", `expected completed, got ${finalTask!.status}`);

    const steps = await db.countTaskSteps(task.id);
    const models = await db.countModelInvocations(task.id);
    assert(steps === 2, `expected exactly 2 steps, got ${steps}`);
    assert(models === 2, `expected exactly 2 model invocations, got ${models}`);

    const cost = await db.sumModelCostUsd(task.id);
    assert(cost > 0, `expected total model cost > 0, got ${cost}`);

    const cp = parseCheckpoint(finalTask!.checkpoint);
    const result = cp.findings.join("\n");
    assert(result.includes("hello from the agent"), "structured result should contain the final answer");

    console.log(
      `[m2] task=${task.id} turns=${models} (exactly-once) cost=$${cost.toFixed(6)} result="${cp.findings.at(-1)}"`,
    );
    console.log("demo-m2 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-m2 FAILED:", err);
  process.exit(1);
});
