import { parseCheckpoint, type Checkpoint, type Id, type Task } from "@marathon/core";

/**
 * Iteration continuity (code-migration.md Track 12; design §7.18, §11.6):
 * resuming a durable human wait with the user's answer, and routing surface
 * replies to the task their thread belongs to.
 */

/** What resume needs from the database (`Database` satisfies this structurally). */
export interface ContinuityDb {
  getTask(taskId: Id): Promise<Task | null>;
  completeStep(taskId: Id, stepType: string, checkpoint: Checkpoint): Promise<void>;
  transitionTask(taskId: Id, to: "running"): Promise<unknown>;
}

export interface ContinuityQueue {
  enqueue(input: { taskId: Id; idempotencyKey?: string }): Promise<{ deduped: boolean }>;
}

export type ResumeOutcome =
  | { resumed: true; task: Task }
  | { resumed: false; reason: "not_found" | "not_waiting" | "duplicate" };

/**
 * Resume a task parked in `waiting_for_input` with the user's answer
 * (Track 12: ask → end turn → resume). The answer lands as a durable
 * `user:answer` step staged in the checkpoint (`pendingUserInput`) — the next
 * turn re-opens the session (`sessionRef`) and consumes it. Idempotent per
 * surface event: a re-delivered reply does not double-enqueue.
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
  if (task.status !== "waiting_for_input") return { resumed: false, reason: "not_waiting" };

  // Stage the answer; the answered question is no longer pending. Recorded as
  // its own step so the timeline shows who unblocked the task and with what.
  const { pendingQuestion: _answered, ...rest } = parseCheckpoint(task.checkpoint);
  await db.completeStep(taskId, "user:answer", { ...rest, pendingUserInput: answer });
  await db.transitionTask(taskId, "running");
  const { deduped } = await queue.enqueue({ taskId, idempotencyKey: opts.idempotencyKey });
  if (deduped) return { resumed: false, reason: "duplicate" };
  return { resumed: true, task };
}
