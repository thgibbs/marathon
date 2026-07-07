import type { Id, Task } from "@marathon/core";
import type { Database } from "@marathon/db";

/** One row of the recent-commands list (design/recent-commands-view.md). */
export interface RecentCommand {
  toolInvocationId: string;
  toolId: string;
  createdAt: Date;
  status: string | null;
  error: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  taskId: string;
  taskStatus: string;
}

function at(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** The most recent `tool_invocation` rows for a tenant, newest first (bounded window, no pagination — v1). */
export async function listRecentCommands(db: Database, tenantId: Id, limit = 100): Promise<RecentCommand[]> {
  const rows = await db.listRecentToolInvocations(tenantId, limit);
  return rows.map((r) => ({
    toolInvocationId: String(r.id),
    toolId: String(r.tool_id),
    createdAt: at(r.created_at),
    status: (r.status as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    inputSummary: (r.input_summary as string | null) ?? null,
    outputSummary: (r.output_summary as string | null) ?? null,
    taskId: String(r.task_id),
    taskStatus: String(r.task_status),
  }));
}

/** Other tasks in the same chain or external conversation as one task (design §4). */
export interface RelatedTasks {
  /** Chain ancestors, closest first (the task this one was spawned from, and so on up). */
  ancestors: Task[];
  /** The most recent task chained off this one, if any. */
  latestDescendant: Task | null;
  /** Total number of tasks chained off this one. */
  descendantCount: number;
  /** Other tasks anchored to the same Slack thread or GitHub PR-revision chain. */
  siblings: Task[];
}

/**
 * Assemble the "previous threads" section of the task detail page: chain
 * ancestry (walking `source_task_id` up) + descendants + thread/PR siblings.
 * Tenant-scoped throughout — an ancestor in another tenant stops the walk.
 */
export async function getRelatedTasks(db: Database, tenantId: Id, task: Task): Promise<RelatedTasks> {
  const ancestors: Task[] = [];
  const seen = new Set<string>([task.id]);
  let cursor = task.sourceTaskId;
  while (cursor && !seen.has(cursor)) {
    const parent = await db.getTask(cursor);
    if (!parent || parent.tenantId !== tenantId) break;
    ancestors.push(parent);
    seen.add(parent.id);
    cursor = parent.sourceTaskId;
  }

  const [latestDescendant, descendantCount] = await Promise.all([
    db.findTaskBySourceTask(task.id),
    db.countTasksBySourceTask(task.id),
  ]);

  let siblings: Task[] = [];
  const channel = task.sourceRef.channel;
  const threadTs = task.sourceRef.thread_ts;
  const repo = task.sourceRef.repo;
  const prNumber = task.sourceRef.prNumber;
  if (task.sourceType === "slack" && typeof channel === "string" && typeof threadTs === "string") {
    siblings = await db.listTasksByThread(tenantId, channel, threadTs);
  } else if (task.sourceType === "github" && task.sourceRef.kind === "code_revision" && typeof repo === "string" && typeof prNumber === "number") {
    siblings = await db.listTasksByRevisionPr(tenantId, repo, prNumber);
  }
  siblings = siblings.filter((t) => t.id !== task.id);

  return { ancestors, latestDescendant, descendantCount, siblings };
}
