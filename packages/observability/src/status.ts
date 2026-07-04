import { parseCheckpoint, type Task } from "@marathon/core";
import { Database } from "@marathon/db";

/**
 * Task status for humans (Track 16, design §15.3): what the task is doing now,
 * what it has finished, what it is waiting on, and what it has cost so far.
 * `taskStatusView` is pure (task -> view) so surfaces and tests can render
 * without a database; `getTaskStatus` assembles the view from the db.
 */
export interface TaskStatusView {
  taskId: string;
  status: string;
  /** One-line state, e.g. "Still running." / "Waiting for your reply." */
  headline: string;
  /** What the task is doing right now (from the checkpoint phase/findings). */
  currentStep?: string;
  completedSteps: string[];
  /** The clarifying question the task is durably waiting on (Track 12). */
  question?: string;
  /** The delivered code PR, once delivery.report_pr has been called. */
  prUrl?: string;
  costUsd: number | null;
}

const HEADLINES: Record<string, string> = {
  created: "Queued.",
  queued: "Queued.",
  running: "Still running.",
  retrying: "Still running (retrying after an error).",
  waiting_for_input: "Waiting for your reply.",
  waiting_for_approval: "Waiting for review — merging the PR is the approval.",
  completed: "Completed.",
  failed: "Failed.",
  cancelled: "Cancelled.",
  expired: "Expired.",
};

/** Human description of a checkpoint phase (the BUILD stage writes these). */
function describePhase(phase: string, turnIndex?: number): string {
  if (phase === "build") {
    return turnIndex !== undefined
      ? `Building in the sandbox (turn ${turnIndex + 1} checkpointed).`
      : "Building in the sandbox.";
  }
  if (phase === "delivering") return "Build finished — delivering the result.";
  return phase;
}

const CURRENT_STEP_CAP = 300;

/** Pure view assembly from the task row (+ cost and PR looked up separately). */
export function taskStatusView(
  task: Task,
  opts: { costUsd?: number | null; prUrl?: string | null } = {},
): TaskStatusView {
  const cp = parseCheckpoint(task.checkpoint);
  const view: TaskStatusView = {
    taskId: task.id,
    status: task.status,
    headline: HEADLINES[task.status] ?? task.status,
    completedSteps: cp.completedSteps,
    costUsd: opts.costUsd ?? null,
  };
  if (cp.pendingQuestion !== undefined) view.question = cp.pendingQuestion;
  if (opts.prUrl) view.prUrl = opts.prUrl;
  // Current step: the phase when the runner reports one (BUILD), else the
  // latest finding — the most recent thing the agent said/observed.
  const lastFinding = cp.findings.at(-1);
  if (cp.phase !== undefined) view.currentStep = describePhase(cp.phase, cp.turnIndex);
  else if (lastFinding && !["completed", "failed", "cancelled", "expired"].includes(task.status)) {
    view.currentStep =
      lastFinding.length > CURRENT_STEP_CAP ? `${lastFinding.slice(0, CURRENT_STEP_CAP)}…` : lastFinding;
  }
  return view;
}

/** Render the §15.3 status reply (markdown-ish, shared across surfaces). */
export function renderStatusText(view: TaskStatusView): string {
  const lines: string[] = [view.headline];
  if (view.question) lines.push(`\n*Waiting on:*\n${view.question}`);
  if (view.currentStep && view.status !== "completed") lines.push(`\n*Current step:*\n${view.currentStep}`);
  if (view.completedSteps.length) {
    lines.push(`\n*Completed:*\n${view.completedSteps.map((s) => `- ${s}`).join("\n")}`);
  }
  if (view.prUrl) lines.push(`\n*Pull request:* ${view.prUrl}`);
  if (typeof view.costUsd === "number") lines.push(`\n_cost so far: $${view.costUsd.toFixed(4)}_`);
  return lines.join("\n");
}

/** Assemble the status view for one task (tenant-isolated; null if unknown). */
export async function getTaskStatus(db: Database, tenantId: string, taskId: string): Promise<TaskStatusView | null> {
  const task = await db.getTask(taskId);
  if (!task || task.tenantId !== tenantId) return null;
  const [costUsd, change] = await Promise.all([
    db.sumModelCostUsd(taskId),
    db.getCodeChangeByTask(taskId),
  ]);
  return taskStatusView(task, { costUsd, prUrl: change?.prUrl ?? null });
}
