import type { MemoryItem } from "./types";

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
 * thread chatter, but among similar items the fresher one wins. An item
 * tagged with the invoking agent gets a small boost (§7.12: agent tags are
 * relevance metadata — they raise ranking, never gate access).
 */
export function blendedScore(similarity: number, recency: number, agentMatch = false): number {
  return 0.8 * similarity + 0.2 * recency + (agentMatch ? 0.1 : 0);
}

export function isExpired(item: Pick<MemoryItem, "expiresAt">, now: number): boolean {
  return item.expiresAt != null && item.expiresAt.getTime() <= now;
}

/** Crude token estimate (~4 chars/token) for the recall token budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Take ranked items up to `limit` and (when set) an approximate token budget. */
export function capResults(items: MemoryItem[], limit: number, tokenBudget?: number): MemoryItem[] {
  const capped = items.slice(0, limit);
  if (tokenBudget == null) return capped;
  const out: MemoryItem[] = [];
  let spent = 0;
  for (const it of capped) {
    spent += estimateTokens(it.text);
    if (out.length > 0 && spent > tokenBudget) break;
    out.push(it);
  }
  return out;
}
