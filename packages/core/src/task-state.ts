/**
 * The durable task state machine (design.md §7.4 / §11.1). `blocked` is retired
 * (§11.1): `retrying` and the waiting states cover its cases.
 */

export type TaskStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ["queued", "cancelled", "failed"],
  queued: ["running", "cancelled", "failed", "expired"],
  running: [
    "waiting_for_input",
    "waiting_for_approval",
    "retrying",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_for_input: ["running", "cancelled", "expired", "failed"],
  waiting_for_approval: ["running", "cancelled", "expired", "failed"],
  retrying: ["running", "failed", "cancelled"],
  // terminal
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export const ALL_TASK_STATUSES = Object.keys(TRANSITIONS) as TaskStatus[];

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const isTerminal = (status: TaskStatus): boolean =>
  TERMINAL_TASK_STATUSES.has(status);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`invalid task transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Throws {@link InvalidTransitionError} if the transition is not allowed. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
