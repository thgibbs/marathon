import { FakeAgentRuntime, type AgentRequest } from "@marathon/agent";
import {
  emptyCheckpoint,
  InMemoryIdempotencyStore,
  parseCheckpoint,
  type Checkpoint,
  type Task,
  type TaskStatus,
} from "@marathon/core";
import type { Database } from "@marathon/db";
import type { Queue } from "@marathon/queue";
import { DeliveryFanout, type SurfaceAdapter } from "@marathon/surface";
import { describe, expect, it } from "vitest";
import { makeAgentStepRunner } from "../src/agent-step";
import { makeWaitingNotifier, renderQuestion, resumeWithInput } from "../src/continuity";
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
  const failures: string[] = [];
  const queue = {
    enqueue: async (input: { taskId: string; idempotencyKey?: string }) => {
      if (input.idempotencyKey && enqueued.includes(input.idempotencyKey)) return { deduped: true };
      if (input.idempotencyKey) enqueued.push(input.idempotencyKey);
      jobs.push({ id: `j${seq++}`, taskId: input.taskId, attempts: 1, leaseToken: `lease${seq}` });
      return { deduped: false };
    },
    dequeue: async () => jobs.shift() ?? null,
    ack: async () => {},
    heartbeat: async () => {},
    // A failed job is redelivered (attempts bumped), like the real queue.
    fail: async (id: string, _token: string, error: string) => {
      failures.push(error);
      jobs.push({ id, taskId: "t1", attempts: (failures.length ?? 0) + 1, leaseToken: `lease${seq++}` });
      return "retry" as const;
    },
    kill: async () => {},
  };
  // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
  return {
    db: db as never as Database,
    queue: queue as never as Queue,
    rawDb: db,
    steps,
    statuses,
    failures,
    current: () => task,
  };
}

describe("durable clarifying questions (Track 12, §11.6)", () => {
  it("publishes the question BEFORE parking, then parks waiting_for_input", async () => {
    const h = makeHarness();
    await (h.queue as unknown as { enqueue: (i: { taskId: string }) => Promise<unknown> }).enqueue({ taskId: "t1" });
    const runtime = new FakeAgentRuntime({
      turns: [{ text: "Need a detail.", ask: "prod or staging?" }, { text: "final answer" }],
    });
    const asked: Array<{ question: string; statusAtPublish: string }> = [];
    const worker = new Worker(h.queue, h.db, {
      stepRunner: makeAgentStepRunner(runtime, request),
      onWaiting: (_taskId, w) =>
        void asked.push({ question: w.question, statusAtPublish: h.current().status }),
    });

    const outcome = await worker.runOnce();
    expect(outcome).toBe("waiting");
    expect(h.current().status).toBe("waiting_for_input");
    // The wait is only "real" once the question was heard: publish came first.
    expect(asked).toEqual([{ question: "prod or staging?", statusAtPublish: "running" }]);
    const cp = parseCheckpoint(h.current().checkpoint);
    expect(cp.pendingQuestion).toBe("prod or staging?");
    expect(cp.completedSteps).toEqual(["turn:0"]); // the asking turn WAS completed
  });

  it("a failed question publish retries the JOB — never parks silently, never fails the task", async () => {
    const h = makeHarness();
    await (h.queue as unknown as { enqueue: (i: { taskId: string }) => Promise<unknown> }).enqueue({ taskId: "t1" });
    const runtime = new FakeAgentRuntime({
      turns: [{ text: "Need a detail.", ask: "prod or staging?" }, { text: "final answer" }],
    });
    let publishAttempts = 0;
    const worker = new Worker(h.queue, h.db, {
      stepRunner: makeAgentStepRunner(runtime, request),
      onWaiting: () => {
        publishAttempts++;
        if (publishAttempts === 1) throw new Error("slack is down"); // NOT a "transient"-classified message
      },
    });

    // Attempt 1: the ask turn persists, the publish fails, the job retries.
    expect(await worker.runOnce()).toBe("retry");
    expect(h.current().status).toBe("running"); // not parked, not failed
    expect(h.failures[0]).toContain("question publish failed");

    // Redelivery: the recovery gate re-publishes from the checkpointed
    // question WITHOUT re-running any turn, then parks.
    expect(await worker.runOnce()).toBe("waiting");
    expect(publishAttempts).toBe(2);
    expect(h.current().status).toBe("waiting_for_input");
    expect(parseCheckpoint(h.current().checkpoint).completedSteps).toEqual(["turn:0"]); // no extra turns
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

  it("a crashed half-resume (answer staged, no job) is REPAIRED by the redelivered event", async () => {
    const h = makeHarness();
    // Simulate the crash window: transition landed, answer staged, but the
    // enqueue never happened (task running + pendingUserInput, empty queue).
    await h.rawDb.transitionTask("t1", "running");
    await h.rawDb.completeStep("t1", "user:answer", {
      completedSteps: ["turn:0"],
      findings: ["Need a detail."],
      pendingUserInput: "staging",
    });

    const repaired = await resumeWithInput(h.db, h.queue, "t1", "staging", { idempotencyKey: "ev-1" });
    expect(repaired.resumed).toBe(true); // the repair path enqueued the missing job
    // And it converges: a further replay of the same event dedupes.
    const replay = await resumeWithInput(h.db, h.queue, "t1", "staging", { idempotencyKey: "ev-1" });
    expect(replay).toEqual({ resumed: false, reason: "duplicate" });
  });

  it("tolerates losing the transition race to a concurrent resume", async () => {
    const h = makeHarness();
    await h.rawDb.transitionTask("t1", "running");
    await h.rawDb.transitionTask("t1", "waiting_for_input");
    // The rival resume transitions the task between our getTask and transition.
    const db = {
      ...h.rawDb,
      transitionTask: async (id: string, to: string) => {
        await h.rawDb.transitionTask(id, "running"); // rival wins first
        if (to === "running") throw new Error("invalid task transition: running -> running");
        return h.current();
      },
    };
    const outcome = await resumeWithInput(db as never as Database, h.queue, "t1", "staging", {
      idempotencyKey: "ev-1",
    });
    expect(outcome.resumed).toBe(true); // converged on the enqueue anyway
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

describe("orphan job against an approval-gated task (§7.4)", () => {
  it("acks a job whose task is waiting_for_approval instead of forcing an invalid ->completed", async () => {
    // The live mention flow completes some tasks INLINE and parks the draft flow
    // at waiting_for_approval, leaving an orphan queue job. A worker that leased
    // it used to run steps and try waiting_for_approval -> completed (invalid),
    // dead-lettering the job. It must ack the orphan as a no-op instead.
    const h = makeHarness();
    await h.rawDb.transitionTask("t1", "running");
    await h.rawDb.transitionTask("t1", "waiting_for_approval");
    const statusesBefore = h.statuses.length;
    await (h.queue as unknown as { enqueue: (i: { taskId: string }) => Promise<unknown> }).enqueue({ taskId: "t1" });

    let stepRan = false;
    const worker = new Worker(h.queue, h.db, {
      stepRunner: async () => {
        stepRan = true;
        throw new Error("stepRunner must not run for a waiting_for_approval task");
      },
    });

    expect(await worker.runOnce()).toBe("completed"); // ack, not dead-letter
    expect(stepRan).toBe(false);
    expect(h.statuses.length).toBe(statusesBefore); // no transition attempted
    expect(h.current().status).toBe("waiting_for_approval"); // left for the human/merge flow
    expect(h.failures).toHaveLength(0); // never failed/retried
  });
});

describe("makeWaitingNotifier (durable question publication)", () => {
  function makeAdapter() {
    const posted: string[] = [];
    const adapter: SurfaceAdapter = {
      acknowledge: async () => {},
      postProgress: async (_ref, message) => void posted.push(message),
      deliverResult: async () => {},
    };
    return { adapter, posted };
  }

  const waitingTask = (overrides: Partial<Task> = {}): Task =>
    ({
      id: "t1",
      tenantId: "tn1",
      sourceType: "slack",
      sourceRef: { channel: "C1", thread_ts: "1.1" },
      deliveryTargets: null,
      status: "waiting_for_input",
      checkpoint: { completedSteps: ["turn:0"], findings: [], pendingQuestion: "prod or staging?" },
      ...overrides,
    }) as never as Task;

  it("fans the question out (source thread fallback) and dedupes per ask", async () => {
    const { adapter, posted } = makeAdapter();
    const fanout = new DeliveryFanout({ slack: adapter }, new InMemoryIdempotencyStore());
    const notify = makeWaitingNotifier({ getTask: async () => waitingTask() }, fanout);

    await notify("t1", { kind: "input", question: "prod or staging?" });
    await notify("t1", { kind: "input", question: "prod or staging?" }); // worker retry
    expect(posted).toEqual([renderQuestion("prod or staging?")]); // deduped per ask
    expect(posted[0]).toContain("❓ prod or staging?");
  });

  it("throws when nobody could hear the question (missing task / no adapters)", async () => {
    const fanout = new DeliveryFanout({}, new InMemoryIdempotencyStore());
    const notify = makeWaitingNotifier({ getTask: async () => waitingTask() }, fanout);
    await expect(notify("t1", { kind: "input", question: "q" })).rejects.toThrow(/no surface heard/);

    const missing = makeWaitingNotifier({ getTask: async () => null }, fanout);
    await expect(missing("t1", { kind: "input", question: "q" })).rejects.toThrow(/not found/);
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
