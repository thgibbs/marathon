import { Database } from "@marathon/db";
import type { MetricsSnapshot } from "./types";

/** A point-in-time health snapshot for a tenant (design §8.5, §16.5). */
export async function getMetrics(db: Database, tenantId: string): Promise<MetricsSnapshot> {
  const [tasksByStatus, jobsByStatus, toolRate, modelRate] = await Promise.all([
    db.countTasksByStatus(tenantId),
    db.countJobsByStatus(),
    db.invocationErrorRate(tenantId, "tool"),
    db.invocationErrorRate(tenantId, "model"),
  ]);
  return {
    tasksByStatus,
    jobsByStatus,
    deadLetter: jobsByStatus.dead ?? 0,
    toolErrorRate: toolRate.rate,
    modelErrorRate: modelRate.rate,
  };
}

/** Cost rollups (per model/agent/task) for a tenant. */
export async function getCostRollup(db: Database, tenantId: string, by: "model" | "agent" | "task") {
  return db.costRollup(tenantId, by);
}
