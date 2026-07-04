import type { MemoryScope, TaskAudience } from "./types";

/**
 * Resolve the "project" for a memory scope (design §7.12). For now a project
 * is a GitHub repo (`owner/name`). On Slack the design wants an
 * admin-declared channel ↔ project mapping; until that exists each channel is
 * its own pseudo-project (`slack:<channel>`) — audience containment holds
 * trivially (a channel's membership is exactly the channel), it's just not
 * yet linked to the repo project. Pluggable so a generated/explicit Project
 * can replace this without touching the store.
 */
export function resolveProjectId(sourceType: string, sourceRef: Record<string, unknown> | undefined): string | undefined {
  if (!sourceRef) return undefined;
  if (typeof sourceRef.repo === "string") return sourceRef.repo; // github: owner/name
  if (sourceType === "slack" && typeof sourceRef.channel === "string") return `slack:${sourceRef.channel}`;
  return undefined;
}

interface TaskIdentity {
  tenantId: string;
  invokingUserId?: string | null;
  sourceType: string;
  sourceRef?: Record<string, unknown>;
}

function resolveThreadId(ref: Record<string, unknown>): string | undefined {
  return (
    (typeof ref.thread_ts === "string" && ref.thread_ts) ||
    (typeof ref.threadTs === "string" && ref.threadTs) ||
    (typeof ref.ts === "string" && ref.ts) ||
    (typeof ref.number === "number" && typeof ref.repo === "string" ? `${ref.repo}#${ref.number}` : undefined) ||
    undefined
  );
}

/** Build a memory scope from a task's identity fields. */
export function scopeForTask(task: TaskIdentity): MemoryScope {
  const ref = task.sourceRef ?? {};
  return {
    tenantId: task.tenantId,
    projectId: resolveProjectId(task.sourceType, ref),
    userId: task.invokingUserId ?? undefined,
    threadId: resolveThreadId(ref),
  };
}

/**
 * Compute the task's audience (§7.12) — deterministic static metadata, never
 * a content classifier:
 *   - GitHub: the repo's audience natively → project level.
 *   - Slack DM (channel id `D…`): the one user → user level.
 *   - Slack channel: the channel pseudo-project (see resolveProjectId).
 *   - No resolvable project: tenant level (the conservative default for an
 *     unknown internal audience).
 * External/guest detection (Slack shared-channel flags) isn't wired yet;
 * callers that know the audience is external must set `external: true`.
 */
export function audienceForTask(task: TaskIdentity): TaskAudience {
  const ref = task.sourceRef ?? {};
  const userId = task.invokingUserId ?? undefined;
  if (task.sourceType === "slack" && typeof ref.channel === "string" && ref.channel.startsWith("D")) {
    return { level: "user", userId, projectId: resolveProjectId(task.sourceType, ref) };
  }
  const projectId = resolveProjectId(task.sourceType, ref);
  if (projectId) return { level: "project", projectId, userId };
  return { level: "tenant", userId };
}
