import { Database } from "@marathon/db";
import type { TaskReport, TimelineEvent } from "./types";

function at(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/**
 * Assemble a per-task timeline (design §11, §16.3) by merging task steps, model
 * calls, tool calls, approvals, and task-scoped audit events in time order.
 */
export async function getTaskTimeline(db: Database, taskId: string): Promise<TimelineEvent[]> {
  const [steps, models, tools, approvals, audits] = await Promise.all([
    db.getTaskSteps(taskId),
    db.getModelInvocations(taskId),
    db.getToolInvocations(taskId),
    db.listApprovalsForTask(taskId),
    db.getTaskAuditEvents(taskId),
  ]);

  const events: TimelineEvent[] = [];

  for (const s of steps) {
    events.push({
      at: at(s.created_at),
      type: "step",
      status: String(s.status ?? ""),
      summary: `step ${s.step_type}${s.error ? ` — error: ${s.error}` : ""}`,
      detail: { retryCount: s.retry_count },
    });
  }
  for (const m of models) {
    events.push({
      at: at(m.created_at),
      type: "model_call",
      status: String(m.status ?? ""),
      summary: `model ${m.provider}:${m.model} ($${Number(m.cost_usd ?? 0).toFixed(4)}, ${m.input_tokens ?? "?"}→${m.output_tokens ?? "?"} tok)`,
      detail: { promptVersion: m.prompt_version, latencyMs: m.latency_ms, error: m.error },
    });
  }
  for (const t of tools) {
    events.push({
      at: at(t.created_at),
      type: "tool_call",
      status: String(t.status ?? ""),
      summary: `tool ${t.tool_id} [${t.risk_level ?? "low"}] ${t.status}${t.error ? ` — ${t.error}` : ""}`,
      detail: { inputSummary: t.input_summary, outputSummary: t.output_summary },
    });
  }
  for (const a of approvals) {
    events.push({
      at: a.createdAt,
      type: "approval",
      status: a.status,
      summary: `approval ${a.status}: ${a.actionSummary ?? ""} [${a.riskLevel ?? "?"}]`,
      detail: { resolvedAt: a.resolvedAt },
    });
  }
  for (const e of audits) {
    events.push({ at: at(e.created_at), type: "audit", summary: `${e.event_type}: ${e.summary ?? ""}` });
  }

  return events.sort((x, y) => x.at.getTime() - y.at.getTime());
}

const FAILED = new Set(["error", "failed", "rejected", "expired", "dead"]);

/** A complete, explainable report for one task (the inspectability API). */
export async function getTaskReport(db: Database, taskId: string): Promise<TaskReport | null> {
  const task = await db.getTask(taskId);
  if (!task) return null;
  const timeline = await getTaskTimeline(db, taskId);
  const models = timeline.filter((e) => e.type === "model_call");
  const promptVersions = [
    ...new Set(models.map((e) => e.detail?.promptVersion).filter((v): v is string => typeof v === "string")),
  ];
  return {
    taskId,
    status: task.status,
    timeline,
    costUsd: await db.sumModelCostUsd(taskId),
    modelCalls: models.length,
    toolCalls: timeline.filter((e) => e.type === "tool_call").length,
    promptVersions,
    failures: timeline.filter((e) => e.status != null && FAILED.has(e.status)),
  };
}
