import type { ApprovalStatus } from "./entities";

const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["approved", "rejected", "expired", "cancelled"],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export function canApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidApprovalTransitionError extends Error {
  constructor(
    public readonly from: ApprovalStatus,
    public readonly to: ApprovalStatus,
  ) {
    super(`invalid approval transition: ${from} -> ${to}`);
    this.name = "InvalidApprovalTransitionError";
  }
}

export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!canApprovalTransition(from, to)) throw new InvalidApprovalTransitionError(from, to);
}

export const isApprovalResolved = (status: ApprovalStatus): boolean => status !== "pending";

/** True when a pending approval's deadline has passed. */
export function isExpired(expiresAt: Date | null, now: number): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now;
}

/** Whether a pending approval should be re-notified (no reminder within intervalMs). */
export function needsReminder(
  createdAt: Date,
  lastReminderAt: Date | null,
  now: number,
  intervalMs: number,
): boolean {
  const since = (lastReminderAt ?? createdAt).getTime();
  return now - since >= intervalMs;
}
