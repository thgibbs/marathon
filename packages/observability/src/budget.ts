import { Database } from "@marathon/db";
import type { BudgetPolicy, BudgetStatus } from "./types";

export class BudgetExceededError extends Error {
  constructor(public readonly status: BudgetStatus) {
    super(`budget exceeded: spent $${status.spentUsd.toFixed(4)} of $${status.limitUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

/** Pure evaluation of spend against a policy. */
export function evaluateBudget(spentUsd: number, policy: BudgetPolicy): BudgetStatus {
  const limitUsd = policy.limitUsd;
  // A non-positive (or non-finite) limit means "no spend allowed" — fail CLOSED,
  // not open. Returning "ok" here would let a zero budget permit unlimited spend.
  if (!(limitUsd > 0)) {
    return { spentUsd, limitUsd, ratio: Infinity, state: "exceeded" };
  }
  const ratio = spentUsd / limitUsd;
  const warnRatio = policy.warnRatio ?? 0.8;
  const state = ratio >= 1 ? "exceeded" : ratio >= warnRatio ? "warn" : "ok";
  return { spentUsd, limitUsd, ratio, state };
}

export interface BudgetScope {
  tenantId: string;
  agentId?: string;
}

/** Evaluate actual model spend (per tenant, optionally per agent) against a budget. */
export async function checkBudget(db: Database, scope: BudgetScope, policy: BudgetPolicy): Promise<BudgetStatus> {
  const spent = await db.sumModelCostUsdByTenant(scope.tenantId, scope.agentId);
  return evaluateBudget(spent, policy);
}

/** Enforce a budget before incurring more spend; throws if already exceeded. */
export async function assertWithinBudget(db: Database, scope: BudgetScope, policy: BudgetPolicy): Promise<BudgetStatus> {
  const status = await checkBudget(db, scope, policy);
  if (status.state === "exceeded") throw new BudgetExceededError(status);
  return status;
}

/**
 * What per-task budget enforcement needs from the database (Track 15, §7.11).
 * Structural so step runners with narrow db seams (BuildStepDb) qualify.
 */
export interface TaskSpendReader {
  sumModelCostUsd(taskId: string): Promise<number>;
}

/** Evaluate one task's actual model spend against its hard cap (design §0.4: "a hard per-task cost cap"). */
export async function checkTaskBudget(db: TaskSpendReader, taskId: string, policy: BudgetPolicy): Promise<BudgetStatus> {
  const spent = await db.sumModelCostUsd(taskId);
  return evaluateBudget(spent, policy);
}

/**
 * Enforce the per-task cap before incurring more spend; throws if already
 * exceeded. Checked at turn boundaries, so a runaway run stops at the first
 * checkpoint past the limit (fail closed) rather than running to completion.
 */
export async function assertWithinTaskBudget(db: TaskSpendReader, taskId: string, policy: BudgetPolicy): Promise<BudgetStatus> {
  const status = await checkTaskBudget(db, taskId, policy);
  if (status.state === "exceeded") throw new BudgetExceededError(status);
  return status;
}
