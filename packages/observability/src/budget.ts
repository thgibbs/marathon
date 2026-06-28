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
  const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
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
