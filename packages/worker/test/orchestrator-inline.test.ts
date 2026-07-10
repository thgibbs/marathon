import type { Task, TaskStatus } from "@marathon/core";
import type { Database } from "@marathon/db";
import { DEFAULT_INLINE_VISIBILITY_MS, type EnqueueInput, type EnqueueResult, type Job, type Queue } from "@marathon/queue";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/worker";

/**
 * Orchestrator.submit's `inline` option (PR #54): an inline-driven task's job
 * row is inserted PRE-LEASED — the inline caller owns the lease, so no worker
 * can dequeue it while the inline run is in flight (dual consumption
 * prevented), but a crashed caller's lease EXPIRES and the normal
 * expired-lease reclaim path recovers the work (never stranded terminal).
 * The returned completeInline handle acks the job when the inline work
 * finishes; idempotency-key dedup keeps working off the same row.
 */

const BASE_TASK = {
  tenantId: "tn1",
  agentId: null,
  agentVersionId: null,
  invokingUserId: null,
  sourceTaskId: null,
  sourceType: "github" as const,
  sourceRef: { kind: "design_review", repo: "o/r", number: 5 },
  deliveryTargets: null,
  status: "created" as TaskStatus,
  inputText: "",
  summary: null,
  checkpoint: null,
  costUsd: 0,
  createdAt: new Date(),
  startedAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  lastError: null,
};

/**
 * In-memory harness FAITHFUL to the real Queue semantics (the repo's queue
 * unit tests are fake-backed; stubs are `as never` at the test boundary, see
 * AGENTS.md rule 1):
 *  - enqueue inline → {status:'leased', leaseToken, leasedUntil: now+window};
 *    non-inline → {status:'ready', leaseToken:null}.
 *  - dequeue leases 'ready' jobs OR 'leased' jobs whose lease expired — the
 *    real reclaim predicate.
 *  - ack only transitions 'leased'→'done' when the token matches.
 */
function makeHarness() {
  const tasks = new Map<string, Task>();
  const transitions: Array<[string, string]> = [];
  let taskSeq = 0;
  const db = {
    createTask: async (): Promise<Task> => {
      const task: Task = { ...BASE_TASK, id: `t${++taskSeq}` };
      tasks.set(task.id, task);
      return task;
    },
    getTask: async (id: string) => tasks.get(id) ?? null,
    transitionTask: async (id: string, to: TaskStatus) => {
      transitions.push([id, to]);
      const task = tasks.get(id);
      if (!task) throw new Error(`task not found: ${id}`);
      const next = { ...task, status: to };
      tasks.set(id, next);
      return next;
    },
  };

  const enqueueCalls: EnqueueInput[] = [];
  const jobs: Job[] = [];
  let jobSeq = 0;
  let tokenSeq = 0;

  const queue = {
    enqueue: async (input: EnqueueInput): Promise<EnqueueResult> => {
      enqueueCalls.push(input);
      // on conflict (idempotency_key) do nothing → fall back to the existing row.
      if (input.idempotencyKey) {
        const existing = jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
        if (existing) return { job: existing, deduped: true };
      }
      const inline = Boolean(input.inline);
      const visibilityMs = input.inlineVisibilityMs ?? DEFAULT_INLINE_VISIBILITY_MS;
      const job: Job = {
        id: `j${++jobSeq}`,
        taskId: input.taskId ?? null,
        kind: input.kind ?? "task",
        idempotencyKey: input.idempotencyKey ?? null,
        status: inline ? "leased" : "ready",
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        availableAt: new Date(),
        leasedUntil: inline ? new Date(Date.now() + visibilityMs) : null,
        leaseToken: inline ? `lt-${++tokenSeq}` : null,
        lastError: null,
      };
      jobs.push(job);
      return { job, deduped: false };
    },
    dequeue: async (visibilityMs: number, opts: { kinds?: string[] } = {}): Promise<Job | null> => {
      const now = Date.now();
      const job = jobs.find(
        (j) =>
          (opts.kinds === undefined || opts.kinds.includes(j.kind)) &&
          ((j.status === "ready" && j.availableAt.getTime() <= now) ||
            (j.status === "leased" && j.leasedUntil !== null && j.leasedUntil.getTime() < now)),
      );
      if (!job) return null;
      job.status = "leased";
      job.attempts += 1;
      job.leaseToken = `lt-${++tokenSeq}`;
      job.leasedUntil = new Date(now + visibilityMs);
      return job;
    },
    ack: async (jobId: string, leaseToken: string): Promise<boolean> => {
      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "leased" || job.leaseToken !== leaseToken) return false;
      job.status = "done";
      job.leasedUntil = null;
      return true;
    },
    findByIdempotencyKey: async (key: string): Promise<Job | null> =>
      jobs.find((j) => j.idempotencyKey === key) ?? null,
    heartbeat: async () => true,
    fail: async () => "retry" as const,
    kill: async () => true,
  };

  return {
    db: db as never as Database,
    queue: queue as never as Queue,
    enqueueCalls,
    jobs,
    transitions,
    /** Simulate the lease window elapsing (a crashed inline caller). */
    expireLease: (job: Job) => {
      job.leasedUntil = new Date(Date.now() - 1);
    },
  };
}

const INLINE_INPUT = {
  tenantId: "tn1",
  sourceType: "github" as const,
  sourceRef: { kind: "design_review" },
};

describe("Orchestrator.submit with inline: true", () => {
  describe("inline + idempotencyKey: a pre-leased job (dedup ledger + crash-recovery hook)", () => {
    it("inserts the job 'leased' with a lease token — dequeue (any kind) returns null while the lease is live", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-1", inline: true });

      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]!.status).toBe("leased");
      expect(h.jobs[0]!.leaseToken).toBeTruthy();
      expect(h.jobs[0]!.leasedUntil!.getTime()).toBeGreaterThan(Date.now());
      // Not leasable by any worker while the inline caller holds the lease.
      expect(await h.queue.dequeue(30_000)).toBeNull();
      expect(await h.queue.dequeue(30_000, { kinds: ["task", "build", "design_review"] })).toBeNull();
    });

    it("CRASH PATH: once the lease expires, dequeue CAN lease the job — the work is recovered, not stranded", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task } = await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-crash", inline: true });

      // The inline caller "crashed": never acked; the lease window elapses.
      h.expireLease(h.jobs[0]!);

      const reclaimed = await h.queue.dequeue(30_000);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.id).toBe(h.jobs[0]!.id);
      expect(reclaimed!.taskId).toBe(task.id);
      expect(reclaimed!.status).toBe("leased"); // now owned by the worker
    });

    it("SUCCESS PATH: completeInline acks the job to 'done'; dequeue returns null even after the window", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { completeInline } = await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-ok", inline: true });

      expect(completeInline).toBeDefined();
      await completeInline!();
      expect(h.jobs[0]!.status).toBe("done");

      // Even if the lease window would have elapsed, a done job is never leased.
      h.jobs[0]!.leasedUntil = new Date(Date.now() - 1);
      expect(await h.queue.dequeue(30_000)).toBeNull();
    });

    it("dedup: re-submit with the same key returns the same task, no handle, and no second runnable job", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);

      const first = await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-dedup", inline: true });
      expect(first.deduped).toBe(false);
      expect(first.completeInline).toBeDefined();

      const second = await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-dedup", inline: true });
      expect(second.deduped).toBe(true);
      expect(second.task.id).toBe(first.task.id);
      // The original submitter owns the ack — the dedup path gets no handle.
      expect(second.completeInline).toBeUndefined();
      // No second job row, and nothing became leasable.
      expect(h.jobs).toHaveLength(1);
      expect(await h.queue.dequeue(30_000)).toBeNull();
    });

    it("still transitions the task to queued (callers immediately go queued→running)", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task } = await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-q", inline: true });
      expect(h.transitions).toContainEqual([task.id, "queued"]);
    });

    it("passes inlineVisibilityMs through to the queue", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({ ...INLINE_INPUT, idempotencyKey: "ik-vis", inline: true, inlineVisibilityMs: 1_000 });
      expect(h.enqueueCalls[0]!.inlineVisibilityMs).toBe(1_000);
      const until = h.jobs[0]!.leasedUntil!.getTime();
      expect(until).toBeLessThanOrEqual(Date.now() + 1_000);
    });
  });

  describe("inline without idempotencyKey: no job row at all (caller runs under its own durable job)", () => {
    it("does not call queue.enqueue — nothing to deduplicate, no queue-level recovery from submit", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task, deduped, completeInline } = await o.submit({ ...INLINE_INPUT, inline: true });
      expect(h.enqueueCalls).toHaveLength(0);
      expect(h.jobs).toHaveLength(0);
      expect(deduped).toBe(false);
      expect(completeInline).toBeUndefined();
      expect(task).toBeDefined();
      expect(await h.queue.dequeue(30_000)).toBeNull();
    });

    it("task is still created and queued even without an enqueue call", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task } = await o.submit({ ...INLINE_INPUT, inline: true });
      expect(h.transitions).toContainEqual([task.id, "queued"]);
    });
  });

  describe("normal (non-inline) submit: unchanged behavior", () => {
    it("enqueues a 'ready' job that dequeue can lease; no completeInline handle", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { completeInline } = await o.submit({
        tenantId: "tn1",
        sourceType: "slack",
        sourceRef: { channel: "C1" },
        idempotencyKey: "ik-normal",
      });
      expect(completeInline).toBeUndefined();
      expect(h.jobs[0]!.status).toBe("ready");
      expect(h.jobs[0]!.leaseToken).toBeNull();
      const leased = await h.queue.dequeue(30_000);
      expect(leased).not.toBeNull();
      expect(leased!.status).toBe("leased");
    });
  });
});
