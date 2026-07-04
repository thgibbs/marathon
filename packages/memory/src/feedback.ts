import type { MemoryItem, MemoryScope, MemoryStore } from "./types";

/**
 * Feedback → memory (design §7.6/§7.12, OQ-3): a correction becomes a durable
 * **user-scoped** long-term memory — self-affecting, so no write gate — tagged
 * with the agent it corrects so recall ranks it higher for that agent's tasks.
 * Broader visibility goes through `promoteMemory` below, never by default:
 * anyone who can react in a channel must not be able to steer every future
 * task tenant-wide (the retired agent-scoped model was that injection channel).
 *
 * Returns the item or null if there's nothing actionable to remember.
 */
export async function rememberCorrection(
  store: MemoryStore,
  scope: MemoryScope,
  correction: string,
  opts: { agentId?: string; taskId?: string } = {},
): Promise<MemoryItem | null> {
  const text = correction.trim();
  if (!text) return null;
  if (!scope.userId) return null; // corrections are user-scoped: no requestor, no write
  return store.remember({
    scope,
    level: "user",
    term: "long",
    kind: "correction",
    text,
    agentId: opts.agentId,
    provenance: { taskId: opts.taskId },
  });
}

/**
 * Promote an item to a broader audience (§7.12 write gates, scaling with
 * blast radius): to **project** — lightweight, any project member (the caller
 * asserts membership; the project can `list`/`forget` it); to **tenant** —
 * requires explicit confirmation by an agent owner / admin. The original
 * narrow item is removed so recall doesn't double-count; the promoted copy
 * records where it came from.
 */
export async function promoteMemory(
  store: MemoryStore,
  item: MemoryItem,
  to: "project" | "tenant",
  opts: { projectId?: string; confirmedBy?: string } = {},
): Promise<MemoryItem> {
  const projectId = opts.projectId ?? item.scope.projectId;
  if (to === "project" && !projectId) throw new Error("memory: promotion to project scope requires a projectId");
  if (to === "tenant" && !opts.confirmedBy) {
    throw new Error("memory: promotion to tenant scope requires confirmedBy (agent owner / admin)");
  }
  const promoted = await store.remember({
    scope: to === "project" ? { tenantId: item.scope.tenantId, projectId } : { tenantId: item.scope.tenantId },
    level: to,
    term: "long",
    kind: item.kind,
    text: item.text,
    agentId: item.agentId,
    metadata: item.metadata,
    provenance: { ...item.provenance, promotedFrom: item.id, confirmedBy: opts.confirmedBy },
  });
  await store.forget({ id: item.id });
  return promoted;
}
