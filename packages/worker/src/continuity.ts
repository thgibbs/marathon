import { parseCheckpoint, type Checkpoint, type DeliveryTarget, type Id, type Task } from "@marathon/core";
import type { DeliveryFanout } from "@marathon/surface";
import { jobKindForSourceRef } from "./build-step";

/**
 * Iteration continuity (code-migration.md Track 12; design §7.18, §11.6):
 * durably publishing clarifying questions, resuming a human wait with the
 * user's answer, and routing surface replies to the task their thread belongs
 * to.
 */

/** What resume needs from the database (`Database` satisfies this structurally). */
export interface ContinuityDb {
  getTask(taskId: Id): Promise<Task | null>;
  completeStep(taskId: Id, stepType: string, checkpoint: Checkpoint): Promise<void>;
  transitionTask(taskId: Id, to: "running"): Promise<unknown>;
}

export interface ContinuityQueue {
  enqueue(input: { taskId: Id; kind?: string; idempotencyKey?: string }): Promise<{ deduped: boolean }>;
}

export type ResumeOutcome =
  | { resumed: true; task: Task }
  | { resumed: false; reason: "not_found" | "not_waiting" | "duplicate" };

/**
 * Resume a task parked in `waiting_for_input` with the user's answer
 * (Track 12: ask → end turn → resume). The answer lands as a durable
 * `user:answer` step staged in the checkpoint (`pendingUserInput`) — the next
 * turn re-opens the session (`sessionRef`) and consumes it.
 *
 * Convergent rather than atomic: each piece (stage answer, transition,
 * enqueue) is individually idempotent, so a crash between them is REPAIRED by
 * the redelivered surface event instead of stranding the task —
 *   - crash before the transition: the task is still waiting; the retry
 *     restages the answer and proceeds;
 *   - crash after the transition but before the enqueue: the retry sees
 *     `running` + a staged answer and just enqueues (the repair path);
 *   - duplicate events: the queue dedupes on the surface-event key.
 * Callers must therefore NOT claim/dedupe the surface event before calling
 * this — redelivery is the retry mechanism.
 */
export async function resumeWithInput(
  db: ContinuityDb,
  queue: ContinuityQueue,
  taskId: Id,
  answer: string,
  opts: { idempotencyKey?: string } = {},
): Promise<ResumeOutcome> {
  const task = await db.getTask(taskId);
  if (!task) return { resumed: false, reason: "not_found" };
  const cp = parseCheckpoint(task.checkpoint);

  if (task.status === "waiting_for_input") {
    // Stage the answer; the answered question is no longer pending. Recorded
    // as its own step so the timeline shows what unblocked the task.
    const { pendingQuestion: _answered, ...rest } = cp;
    await db.completeStep(taskId, "user:answer", { ...rest, pendingUserInput: answer });
    try {
      await db.transitionTask(taskId, "running");
    } catch (err) {
      // A concurrent resume won the transition; converge on the enqueue below.
      const current = await db.getTask(taskId);
      if (current?.status !== "running") throw err;
    }
  } else if (!(task.status === "running" && cp.pendingUserInput !== undefined)) {
    return { resumed: false, reason: "not_waiting" };
  }

  // The answer is staged and the task is running — the only remaining durable
  // effect is the job, idempotent on the surface event. The kind is re-derived
  // from the task so the resume reaches the same worker partition (Track 15).
  const { deduped } = await queue.enqueue({
    taskId,
    kind: jobKindForSourceRef(task.sourceRef),
    idempotencyKey: opts.idempotencyKey,
  });
  if (deduped) return { resumed: false, reason: "duplicate" };
  return { resumed: true, task };
}

/** What the question notifier needs from the database. */
export interface WaitingNotifierDb {
  getTask(taskId: Id): Promise<Task | null>;
}

/** Render the in-surface clarifying question (kept in one place for dedupe/tests). */
export function renderQuestion(question: string): string {
  return `❓ ${question}\n_Reply in this thread to continue._`;
}

/**
 * The `WorkerOptions.onWaiting` implementation (Track 12, §11.6): fan the
 * clarifying question out to every delivery target, idempotently per ask
 * (keyed on the asking turn, so worker retries cannot double-post but a later
 * second question still goes out). Throws when nothing was delivered — the
 * worker keeps the job alive and retries, because a question nobody heard is
 * a stuck task.
 */
export function makeWaitingNotifier(
  db: WaitingNotifierDb,
  fanout: DeliveryFanout,
): (taskId: Id, waiting: { kind: "input"; question: string }) => Promise<void> {
  return async (taskId, waiting) => {
    const task = await db.getTask(taskId);
    if (!task) throw new Error(`waiting notifier: task ${taskId} not found`);
    const targets: DeliveryTarget[] =
      task.deliveryTargets ?? [{ surfaceType: task.sourceType, ref: task.sourceRef }];
    const cp = parseCheckpoint(task.checkpoint);
    const outcomes = await fanout.postProgress(
      taskId,
      targets,
      renderQuestion(waiting.question),
      `question:${cp.completedSteps.length}`,
    );
    if (outcomes.length === 0 || outcomes.every((o) => o.status === "no_adapter")) {
      throw new Error(
        `waiting notifier: no surface heard the question for task ${taskId} (targets: ${outcomes.length})`,
      );
    }
  };
}
