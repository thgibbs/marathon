import type { Task, TaskStatus } from "@marathon/core";
import type { Database } from "@marathon/db";
import type { EnqueueInput, EnqueueResult, Job, Queue } from "@marathon/queue";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/worker";

/**
 * Tests for the Orchestrator.submit `inline` option (Fix 1): inline-driven
 * tasks must never be leasable by a queue Worker, while idempotency-key dedup
 * must keep working (InvocationRouter relies on the job row keyed by
 * surfaceEventKey to deduplicate webhook redeliveries).
 */

const BASE_TASK: Task = {
  id: "t1",
  tenantId: "tn1",
  agentId: null,
  agentVersionId: null,
  invokingUserId: null,
  sourceTaskId: null,
  sourceType: "github",
  sourceRef: { kind: "design_review", repo: "o/r", number: 5 },
  deliveryTargets: null,
  status: "queued",
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

interface EnqueueCall {
  input: EnqueueInput;
}

/** Minimal in-memory harness for Orchestrator tests. */
function makeHarness(opts: { existingByKey?: Job | null } = {}) {
  let task: Task = { ...BASE_TASK };
  const transitions: Array<[string, string]> = [];
  const db = {
    createTask: async () => ({ ...task }),
    getTask: async () => task,
    transitionTask: async (id: string, to: TaskStatus) => {
      transitions.push([id, to]);
      task = { ...task, status: to };
      return task;
    },
    findOrCreateUserByIdentity: async () => ({ id: "u1" }),
  };

  const enqueueCalls: EnqueueCall[] = [];
  const jobs: Job[] = [];
  let seq = 0;

  const queue = {
    enqueue: async (input: EnqueueInput): Promise<EnqueueResult> => {
      enqueueCalls.push({ input });
      const job: Job = {
        id: `j${++seq}`,
        taskId: input.taskId ?? null,
        kind: input.kind ?? "task",
        idempotencyKey: input.idempotencyKey ?? null,
        status: input.inline ? "done" : "ready",
        attempts: 0,
        maxAttempts: 5,
        availableAt: new Date(),
        leasedUntil: null,
        leaseToken: null,
        lastError: null,
      };
      jobs.push(job);
      return { job, deduped: false };
    },
    dequeue: async (): Promise<Job | null> => {
      // Only lease 'ready' or expired-leased jobs, never 'done'.
      return jobs.find((j) => j.status === "ready") ?? null;
    },
    findByIdempotencyKey: async (key: string): Promise<Job | null> => {
      if (opts.existingByKey && opts.existingByKey.idempotencyKey === key) {
        return opts.existingByKey;
      }
      return jobs.find((j) => j.idempotencyKey === key) ?? null;
    },
    ack: async () => {},
    heartbeat: async () => {},
    fail: async () => "retry" as const,
    kill: async () => {},
  };

  return {
    db: db as never as Database,
    queue: queue as never as Queue,
    enqueueCalls,
    jobs,
    transitions,
    current: () => task,
  };
}

describe("Orchestrator.submit with inline: true", () => {
  describe("inline + idempotencyKey: inserts a done-status job for dedup, never leasable", () => {
    it("enqueues a job with inline=true passed through to Queue.enqueue", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        idempotencyKey: "ik-1",
        inline: true,
      });
      expect(h.enqueueCalls).toHaveLength(1);
      expect(h.enqueueCalls[0]!.input.inline).toBe(true);
      expect(h.enqueueCalls[0]!.input.idempotencyKey).toBe("ik-1");
    });

    it("the inserted job is 'done' — dequeue returns nothing (not leasable by any worker)", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        idempotencyKey: "ik-dequeue",
        inline: true,
      });
      // The job was enqueued as 'done'; dequeue must not return it.
      const leased = await h.queue.dequeue(30_000);
      expect(leased).toBeNull();
    });

    it("dedup: re-submit with the same idempotencyKey returns the original task (deduped: true)", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);

      // First submit creates the task and the ledger job.
      const first = await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        idempotencyKey: "ik-dedup",
        inline: true,
      });
      expect(first.deduped).toBe(false);

      // Second submit with the same key finds the existing job row → deduped.
      const second = await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        idempotencyKey: "ik-dedup",
        inline: true,
      });
      expect(second.deduped).toBe(true);
      expect(second.task.id).toBe(first.task.id);
      // The task was not enqueued a second time.
      expect(h.enqueueCalls).toHaveLength(1);
    });

    it("task is still transitioned to queued after create (callers immediately go queued→running)", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        idempotencyKey: "ik-queued",
        inline: true,
      });
      expect(h.transitions).toContainEqual(["t1", "queued"]);
    });
  });

  describe("inline without idempotencyKey: no job row inserted (nothing to deduplicate)", () => {
    it("does not call queue.enqueue when inline is true and no idempotencyKey is provided", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task, deduped } = await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        inline: true,
        // no idempotencyKey
      });
      expect(h.enqueueCalls).toHaveLength(0);
      expect(deduped).toBe(false);
      expect(task).toBeDefined();
    });

    it("dequeue still returns nothing — no job was inserted at all", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        inline: true,
      });
      expect(await h.queue.dequeue(30_000)).toBeNull();
    });

    it("task is created and queued even without an enqueue call", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      const { task } = await o.submit({
        tenantId: "tn1",
        sourceType: "github",
        sourceRef: { kind: "design_review" },
        inline: true,
      });
      expect(task).toBeDefined();
      expect(h.transitions).toContainEqual(["t1", "queued"]);
    });
  });

  describe("normal (non-inline) submit: unchanged behavior", () => {
    it("enqueues a ready job that dequeue can lease", async () => {
      const h = makeHarness();
      const o = new Orchestrator(h.db, h.queue);
      await o.submit({
        tenantId: "tn1",
        sourceType: "slack",
        sourceRef: { channel: "C1" },
        idempotencyKey: "ik-normal",
      });
      expect(h.enqueueCalls[0]!.input.inline).toBeUndefined();
      const leased = await h.queue.dequeue(30_000);
      expect(leased).not.toBeNull();
      expect(leased!.status).toBe("ready");
    });
  });
});
