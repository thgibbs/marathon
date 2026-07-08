import type { Checkpoint, Task, TaskStatus } from "@marathon/core";
import type { Database } from "@marathon/db";
import type { Queue } from "@marathon/queue";
import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker";

/** Minimal in-memory harness: exactly what Worker touches on a permanent failure. */
function makeHarness() {
  let task: Task = {
    id: "t1",
    tenantId: "tn1",
    agentId: null,
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.1" },
    deliveryTargets: null,
    status: "queued",
    inputText: "do something",
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
  const db = {
    getTask: async () => task,
    transitionTask: async (_id: string, to: TaskStatus, opts?: { error?: string }) => {
      task = { ...task, status: to, lastError: opts?.error ?? task.lastError };
      return task;
    },
    completeStep: async (_id: string, _stepType: string, checkpoint: Checkpoint) => {
      task = { ...task, checkpoint: checkpoint as unknown as Record<string, unknown> };
    },
  };
  const killed: string[] = [];
  const job = { id: "j1", taskId: "t1", attempts: 1, leaseToken: "lease1" };
  let dequeued = false;
  const queue = {
    dequeue: async () => (dequeued ? null : ((dequeued = true), job)),
    ack: async () => {},
    heartbeat: async () => {},
    kill: async (_id: string, _token: string, error: string) => void killed.push(error),
  };
  return {
    db: db as never as Database,
    queue: queue as never as Queue,
    current: () => task,
    killed,
  };
}

describe("permanent step failures persist their reason (design/30-task-failure-reporting.md)", () => {
  it("safeFailTask stamps last_error via transitionTask instead of discarding it", async () => {
    const h = makeHarness();
    const worker = new Worker(h.queue, h.db, {
      stepRunner: async () => {
        throw new Error("budget exceeded: spent $5.0000 of $5.00");
      },
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("dead");
    expect(h.current().status).toBe("failed");
    expect(h.current().lastError).toBe("Error: budget exceeded: spent $5.0000 of $5.00");
    expect(h.killed).toEqual(["Error: budget exceeded: spent $5.0000 of $5.00"]);
  });

  it("persists a non-budget permanent error too, not just budget failures", async () => {
    const h = makeHarness();
    const worker = new Worker(h.queue, h.db, {
      stepRunner: async () => {
        throw new Error("unexpected: tool schema rejected the call");
      },
    });

    await worker.runOnce();

    expect(h.current().status).toBe("failed");
    expect(h.current().lastError).toBe("Error: unexpected: tool schema rejected the call");
  });
});
