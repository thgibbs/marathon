import { FakeAgentRuntime, type AgentRequest } from "@marathon/agent";
import {
  emptyCheckpoint,
  parseCheckpoint,
  type Checkpoint,
  type Task,
  type TaskStatus,
} from "@marathon/core";
import type { Database } from "@marathon/db";
import type { Queue } from "@marathon/queue";
import { describe, expect, it } from "vitest";
import { makeAgentStepRunner } from "../src/agent-step";
import { resumeWithInput } from "../src/continuity";
import { Worker } from "../src/worker";

const request: AgentRequest = {
  taskId: "t1",
  instructions: "be brief",
  input: "why did checkout errors spike?",
  modelRef: "fake:echo",
};

/** In-memory task store + queue implementing exactly what Worker/resume touch. */
function makeHarness() {
  const steps: Array<{ stepType: string; checkpoint: Checkpoint }> = [];
  const statuses: TaskStatus[] = [];
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
    inputText: "why did checkout errors spike?",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
  };
  const db = {
    getTask: async () => task,
    transitionTask: async (_id: string, to: TaskStatus) => {
      statuses.push(to);
      task = { ...task, status: to };
      return task;
    },
    completeStep: async (_id: string, stepType: string, checkpoint: Checkpoint) => {
      steps.push({ stepType, checkpoint });
      task = { ...task, checkpoint: checkpoint as unknown as Record<string, unknown> };
    },
  };
  const jobs: Array<{ id: string; taskId: string; attempts: number; leaseToken: string }> = [];
  let seq = 1;
  const enqueued: string[] = [];
  const queue = {
    enqueue: async (input: { taskId: string; idempotencyKey?: string }) => {
      if (input.idempotencyKey && enqueued.includes(input.idempotencyKey)) return { deduped: true };
      if (input.idempotencyKey) enqueued.push(input.idempotencyKey);
      jobs.push({ id: `j${seq++}`, taskId: input.taskId, attempts: 0, leaseToken: `lease${seq}` });
      return { deduped: false };
    },
    dequeue: async () => jobs.shift() ?? null,
    ack: async () => {},
    heartbeat: async () => {},
    fail: async () => "retry" as const,
    kill: async () => {},
  };
  // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
  return { db: db as never as Database, queue: queue as never as Queue, rawDb: db, steps, statuses, current: () => task };
}

describe("durable clarifying questions (Track 12, §11.6)", () => {
  it("parks the task waiting_for_input, persists the question, and fires onWaiting", async () => {
    const h = makeHarness();
    await (h.queue as unknown as { enqueue: (i: { taskId: string }) => Promise<unknown> }).enqueue({ taskId: "t1" });
    const runtime = new FakeAgentRuntime({
      turns: [{ text: "Need a detail.", ask: "prod or staging?" }, { text: "final answer" }],
    });
    const asked: string[] = [];
    const worker = new Worker(h.queue, h.db, {
      stepRunner: makeAgentStepRunner(runtime, request),
      onWaiting: (_taskId, w) => void asked.push(w.question),
    });

    const outcome = await worker.runOnce();
    expect(outcome).toBe("waiting");
    expect(h.current().status).toBe("waiting_for_input");
    expect(asked).toEqual(["prod or staging?"]);
    const cp = parseCheckpoint(h.current().checkpoint);
    expect(cp.pendingQuestion).toBe("prod or staging?");
    expect(cp.completedSteps).toEqual(["turn:0"]); // the asking turn WAS completed
  });

  it("resume stages the answer as a durable user:answer step and re-enqueues", async () => {
    const h = makeHarness();
    await h.rawDb.transitionTask("t1", "running");
    await h.rawDb.completeStep("t1", "turn:0", {
      completedSteps: ["turn:0"],
      findings: ["Need a detail."],
      pendingQuestion: "prod or staging?",
    });
    await h.rawDb.transitionTask("t1", "waiting_for_input");

    const outcome = await resumeWithInput(h.db, h.queue, "t1", "staging", { idempotencyKey: "ev-1" });
    expect(outcome.resumed).toBe(true);
    expect(h.current().status).toBe("running");
    const staged = h.steps.at(-1)!;
    expect(staged.stepType).toBe("user:answer");
    expect(staged.checkpoint.pendingUserInput).toBe("staging");
    expect(staged.checkpoint.pendingQuestion).toBeUndefined(); // answered
    expect(staged.checkpoint.completedSteps).toEqual(["turn:0"]); // turn count untouched
  });

  it("resume refuses tasks that are not waiting, and dedupes replayed reply events", async () => {
    const h = makeHarness();
    const notWaiting = await resumeWithInput(h.db, h.queue, "t1", "hi");
    expect(notWaiting).toEqual({ resumed: false, reason: "not_waiting" });

    await h.rawDb.transitionTask("t1", "running");
    await h.rawDb.transitionTask("t1", "waiting_for_input");
    const first = await resumeWithInput(h.db, h.queue, "t1", "staging", { idempotencyKey: "ev-1" });
    expect(first.resumed).toBe(true);
    await h.rawDb.transitionTask("t1", "waiting_for_input"); // hypothetical second wait
    const replay = await resumeWithInput(h.db, h.queue, "t1", "staging", { idempotencyKey: "ev-1" });
    expect(replay).toEqual({ resumed: false, reason: "duplicate" });
  });

  it("ask -> park -> resume -> complete: the full loop, exactly once per turn", async () => {
    const h = makeHarness();
    await (h.queue as unknown as { enqueue: (i: { taskId: string }) => Promise<unknown> }).enqueue({ taskId: "t1" });
    const seen: string[] = [];
    const runtime = new FakeAgentRuntime({
      turns: [{ text: "Need a detail.", ask: "prod or staging?" }, { text: "Staging traces to PR #4901." }],
    });
    // Wrap to observe the input each turn actually received.
    const observing = {
      nextTurn: async (ctx: Parameters<typeof runtime.nextTurn>[0]) => {
        seen.push(ctx.request.input);
        return runtime.nextTurn(ctx);
      },
    };
    const worker = new Worker(h.queue, h.db, { stepRunner: makeAgentStepRunner(observing, request) });

    expect(await worker.runOnce()).toBe("waiting");
    const resumed = await resumeWithInput(h.db, h.queue, "t1", "staging");
    expect(resumed.resumed).toBe(true);
    expect(await worker.runOnce()).toBe("completed");

    expect(h.current().status).toBe("completed");
    const cp = parseCheckpoint(h.current().checkpoint);
    expect(cp.completedSteps).toEqual(["turn:0", "turn:1"]); // no re-run of the asking turn
    expect(cp.findings.at(-1)).toContain("PR #4901");
    expect(cp.pendingUserInput).toBeUndefined(); // the answer was consumed
    // Turn 1's input was the fenced ANSWER, not the original ask.
    expect(seen[1]).toContain("staging");
    expect(seen[1]).toMatch(/<<<UNTRUSTED user answer>>>/);
  });
});

describe("checkpoint wait fields survive parseCheckpoint", () => {
  it("round-trips pendingQuestion/pendingUserInput and drops garbage", () => {
    const cp = parseCheckpoint({
      ...emptyCheckpoint(),
      pendingQuestion: "which env?",
      pendingUserInput: "staging",
    });
    expect(cp.pendingQuestion).toBe("which env?");
    expect(cp.pendingUserInput).toBe("staging");
    expect(parseCheckpoint({ pendingQuestion: 42 }).pendingQuestion).toBeUndefined();
  });
});
