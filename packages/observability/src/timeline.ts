import { Database } from "@marathon/db";
import type { TaskReport, TimelineEvent } from "./types";

function at(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** Compact rendering of risk axes (design §7.8), e.g. " [irreversible,external]". */
function riskSummary(axes: unknown): string {
  if (!axes || typeof axes !== "object") return "";
  const a = axes as { reversible?: boolean; crossesTrustBoundary?: boolean; audience?: string; costly?: boolean };
  const flags = [
    a.reversible === false ? "irreversible" : null,
    a.crossesTrustBoundary ? "trust-boundary" : null,
    a.audience ?? null,
    a.costly ? "costly" : null,
  ].filter((f): f is string => f !== null);
  return flags.length ? ` [${flags.join(",")}]` : "";
}

/**
 * Assemble a per-task timeline (design §11, §16.3) by merging task steps, model
 * calls, tool calls, approvals, and task-scoped audit events in time order.
 */
export async function getTaskTimeline(db: Database, tenantId: string, taskId: string): Promise<TimelineEvent[]> {
  // Tenant isolation: never assemble a timeline for a task in another tenant.
  const task = await db.getTask(taskId);
  if (!task || task.tenantId !== tenantId) return [];
  const [steps, models, tools, approvals, audits, change] = await Promise.all([
    db.getTaskSteps(taskId),
    db.getModelInvocations(taskId),
    db.getToolInvocations(taskId),
    db.listApprovalsForTask(taskId),
    db.getTaskAuditEvents(taskId),
    db.getCodeChangeByTask(taskId),
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
      summary: `tool ${t.tool_id}${riskSummary(t.risk_axes)} ${t.status}${t.error ? ` — ${t.error}` : ""}`,
      detail: { inputSummary: t.input_summary, outputSummary: t.output_summary },
    });
  }
  for (const a of approvals) {
    events.push({
      at: a.createdAt,
      type: "approval",
      status: a.status,
      summary: `approval ${a.status}: ${a.actionSummary ?? ""}${riskSummary(a.riskAxes)}`,
      detail: { resolvedAt: a.resolvedAt },
    });
  }
  for (const e of audits) {
    events.push({ at: at(e.created_at), type: "audit", summary: `${e.event_type}: ${e.summary ?? ""}` });
  }
  // Delivery events (Track 16): the code PR + its verification runs, first-class
  // in the timeline instead of buried in the CodeChange row. The brokered
  // git.exec/github.exec/delivery.report_pr calls already appear as tool_call
  // events above; this is the *outcome* view.
  if (change) {
    for (const v of change.verification) {
      events.push({
        at: at(change.updatedAt),
        type: "delivery",
        status: v.exitCode === 0 ? "pass" : "fail",
        summary: `verification \`${v.command}\` exit ${v.exitCode}${v.summary ? ` — ${v.summary}` : ""}`,
      });
    }
    if (change.prUrl) {
      events.push({
        at: at(change.updatedAt),
        type: "delivery",
        status: change.state,
        summary: `PR reported: ${change.prUrl} (${change.state})`,
        detail: { branch: change.branch, baseSha: change.baseSha },
      });
    }
  }

  return events.sort((x, y) => x.at.getTime() - y.at.getTime());
}

const FAILED = new Set(["error", "failed", "rejected", "expired", "dead"]);

/** A complete, explainable report for one task (the inspectability API). */
export async function getTaskReport(db: Database, tenantId: string, taskId: string): Promise<TaskReport | null> {
  const task = await db.getTask(taskId);
  if (!task || task.tenantId !== tenantId) return null; // tenant isolation
  const timeline = await getTaskTimeline(db, tenantId, taskId);
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
