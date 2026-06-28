import type { MemoryScope } from "./types";

/**
 * Resolve the "project" for a memory scope (design §7.12). For now a project is a
 * GitHub repo (`owner/name`); Slack falls back to a channel namespace. Pluggable so a
 * generated/explicit Project can replace this without touching the store.
 */
export function resolveProjectId(sourceType: string, sourceRef: Record<string, unknown> | undefined): string | undefined {
  if (!sourceRef) return undefined;
  if (typeof sourceRef.repo === "string") return sourceRef.repo; // github: owner/name
  if (sourceType === "slack" && typeof sourceRef.channel === "string") return `slack:${sourceRef.channel}`;
  return undefined;
}

/** Build a memory scope from a task's identity fields. */
export function scopeForTask(task: {
  tenantId: string;
  agentId?: string | null;
  sourceType: string;
  sourceRef?: Record<string, unknown>;
}): MemoryScope {
  const ref = task.sourceRef ?? {};
  const threadId =
    (typeof ref.threadTs === "string" && ref.threadTs) ||
    (typeof ref.ts === "string" && ref.ts) ||
    (typeof ref.number === "number" && typeof ref.repo === "string" ? `${ref.repo}#${ref.number}` : undefined) ||
    undefined;
  return {
    tenantId: task.tenantId,
    agentId: task.agentId ?? undefined,
    projectId: resolveProjectId(task.sourceType, ref),
    threadId,
  };
}
