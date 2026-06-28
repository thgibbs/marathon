import type { MemoryScope, MemoryStore } from "./types";

/**
 * Feedback → memory (design §7.6/§7.12): a correction becomes a durable, agent-scoped
 * long-term memory so the agent stops repeating the mistake. Returns the item or null
 * if there's nothing actionable to remember.
 */
export async function rememberCorrection(
  store: MemoryStore,
  scope: MemoryScope,
  correction: string,
  source?: { taskId?: string },
): Promise<{ id: string } | null> {
  const text = correction.trim();
  if (!text) return null;
  if (!scope.agentId) return null; // corrections are agent-scoped
  return store.remember({
    scope,
    level: "agent",
    term: "long",
    kind: "correction",
    text,
    source,
  });
}
