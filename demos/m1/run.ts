/**
 * M1 automated demo (roadmap.md M1 exit criteria).
 *
 *   - submit a task (Orchestrator) -> enqueue with an idempotency key
 *   - a DUPLICATE enqueue is asserted to be a no-op
 *   - worker #1 runs one step, checkpoints, then CRASHES (abandons its lease)
 *   - after the visibility timeout, worker #2 reclaims the job and RESUMES from
 *     the checkpoint, completing the task EXACTLY ONCE
 *   - asserts: task completed, exactly N step rows, job done
 *
 * Prints "demo-m1 OK" on success; exits non-zero on failure.
 * Requires Postgres reachable at DATABASE_URL.
 */
import { loadConfig } from "@marathon/config";
import { surfaceEventKey } from "@marathon/core";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { makeSyntheticStepRunner, Orchestrator, parseCheckpoint, Worker } from "@marathon/worker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const applied = await migrate(cfg.databaseUrl);
  console.log(`[m1] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  const orchestrator = new Orchestrator(db, queue);
  const steps = ["load_context", "plan", "finalize"];

  try {
    const tenant = await db.createTenant({ name: `demo-m1-${Date.now()}` });
    const user = await db.createUser({ tenantId: tenant.id, role: "admin" });

    // unique per-run idempotency key (simulates a Slack event id)
    const idemKey = surfaceEventKey("slack", `evt-${tenant.id}`);

    const { task, deduped } = await orchestrator.submit({
      tenantId: tenant.id,
      invokingUserId: user.id,
      sourceType: "slack",
      sourceRef: { channel: "C1", thread_ts: "1.0" },
      inputText: "do the synthetic work",
      idempotencyKey: idemKey,
    });
    assert(!deduped, "first submit should not be deduped");
    console.log(`[m1] submitted task ${task.id} (status=${task.status})`);

    // duplicate enqueue is a no-op
    const dup = await queue.enqueue({ taskId: task.id, idempotencyKey: idemKey });
    assert(dup.deduped, "duplicate enqueue should be deduped");
    console.log("[m1] duplicate enqueue -> deduped (no-op)");

    // --- worker #1: run one step then crash (abandon lease) ---
    const visibilityMs = 1000;
    const w1 = new Worker(queue, db, {
      stepRunner: makeSyntheticStepRunner(steps),
      visibilityMs,
      crashAfterStepIndex: 0, // crash right after the first step is persisted
    });
    const o1 = await w1.runOnce();
    assert(o1 === "crashed", `worker #1 expected 'crashed', got '${o1}'`);

    const afterCrash = await db.getTask(task.id);
    assert(afterCrash !== null, "task should exist after crash");
    assert(afterCrash!.status === "running", `expected running after crash, got ${afterCrash!.status}`);
    const cp1 = parseCheckpoint(afterCrash!.checkpoint);
    assert(cp1.completedSteps.length === 1, `expected 1 completed step, got ${cp1.completedSteps.length}`);
    assert((await db.countTaskSteps(task.id)) === 1, "expected exactly 1 step row after crash");
    console.log(`[m1] worker #1 crashed after step '${cp1.completedSteps[0]}' (checkpoint persisted)`);

    // --- wait past the visibility timeout so the lease is reclaimable ---
    await sleep(visibilityMs + 500);

    // --- worker #2: reclaim + resume to completion ---
    const w2 = new Worker(queue, db, {
      stepRunner: makeSyntheticStepRunner(steps),
      visibilityMs: 10_000,
    });
    const outcomes = await w2.drain();
    console.log(`[m1] worker #2 outcomes: ${outcomes.join(", ")}`);
    assert(outcomes.includes("completed"), "worker #2 should complete the task");

    // --- assertions: exactly-once resume ---
    const finalTask = await db.getTask(task.id);
    assert(finalTask!.status === "completed", `expected completed, got ${finalTask!.status}`);

    const stepCount = await db.countTaskSteps(task.id);
    assert(stepCount === steps.length, `expected exactly ${steps.length} step rows, got ${stepCount}`);

    const finalCp = parseCheckpoint(finalTask!.checkpoint);
    assert(finalCp.completedSteps.length === steps.length, "checkpoint should list all steps");
    assert(finalCp.findings.length === steps.length, "findings should be recorded once per step");

    // job should be done
    const j = await queue.findByIdempotencyKey(idemKey);
    assert(j !== null && j.status === "done", `expected job 'done', got '${j?.status}'`);

    console.log(
      `[m1] task=${task.id} steps=${stepCount} (exactly-once) checkpoint=[${finalCp.completedSteps.join(", ")}]`,
    );
    console.log("demo-m1 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-m1 FAILED:", err);
  process.exit(1);
});
