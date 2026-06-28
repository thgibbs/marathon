import type { MemoryItem, MemoryScope, MemoryLevel } from "./types";

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // inputs are L2-normalized by the embedder
}

/** Recency weight in [0,1] — newer is higher; ~half-life of 7 days. */
export function recencyWeight(createdAt: Date, now: number): number {
  const ageMs = Math.max(0, now - createdAt.getTime());
  const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * Rank by relevance, with recency as a mild tiebreaker, so both terms can be
 * searched together: a relevant long-term correction isn't buried by recent
 * thread chatter, but among similar items the fresher one wins.
 */
export function blendedScore(similarity: number, recency: number): number {
  return 0.8 * similarity + 0.2 * recency;
}

/** Does an item at its level apply to a query scope? (tenant always; others must match.) */
export function scopeMatches(itemScope: MemoryScope, level: MemoryLevel, query: MemoryScope): boolean {
  if (itemScope.tenantId !== query.tenantId) return false;
  switch (level) {
    case "tenant":
      return true;
    case "project":
      return !!query.projectId && itemScope.projectId === query.projectId;
    case "agent":
      return !!query.agentId && itemScope.agentId === query.agentId;
    case "thread":
      return !!query.threadId && itemScope.threadId === query.threadId;
  }
}

export function isExpired(item: Pick<MemoryItem, "expiresAt">, now: number): boolean {
  return item.expiresAt != null && item.expiresAt.getTime() <= now;
}
