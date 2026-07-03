import { createHash } from "node:crypto";
import type { EffectExecutionState } from "./entities";
import { stableStringify } from "./idempotency";

/**
 * The Proposed Effect lifecycle (design §7.9, §10.17; code-migration.md
 * Track 9). Marathon approval is *rare*: normal code delivery uses GitHub's
 * native review (agent opens PR → human reviews → human merges). Only direct
 * destructive actions — merge a PR, delete a branch, change production data —
 * go through propose → approve → execute, and the executor is a plain
 * host-side function, never a model tool call (the old `executeApproved()`
 * tool-replay model is retired for new work).
 */
const TRANSITIONS: Record<EffectExecutionState, readonly EffectExecutionState[]> = {
  proposed: ["approved", "rejected", "expired"],
  approved: ["executing", "expired"],
  executing: ["executed", "failed"],
  executed: [],
  failed: [],
  rejected: [],
  expired: [],
};

export function canEffectTransition(from: EffectExecutionState, to: EffectExecutionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidEffectTransitionError extends Error {
  constructor(
    public readonly from: EffectExecutionState,
    public readonly to: EffectExecutionState,
  ) {
    super(`invalid proposed-effect transition: ${from} -> ${to}`);
    this.name = "InvalidEffectTransitionError";
  }
}

export function assertEffectTransition(from: EffectExecutionState, to: EffectExecutionState): void {
  if (!canEffectTransition(from, to)) throw new InvalidEffectTransitionError(from, to);
}

/**
 * The hash approval binds to (§7.9): sha256 over the *exact* proposed payload
 * (deterministic key order). If the payload changes, the hash changes and any
 * prior approval is void.
 */
export function payloadHashOf(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Idempotency key bounding a proposal (and thus its execution) to at most once. */
export function proposedEffectKey(taskId: string, effectType: string, payloadHash: string): string {
  return `task:${taskId}:effect:${effectType}:${payloadHash.slice(0, 32)}`;
}
