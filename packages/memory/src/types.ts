/** Memory model — design §7.12 (scope × term, searched together). */
export type MemoryTerm = "short" | "long";
export type MemoryLevel = "tenant" | "project" | "agent" | "thread";

export interface MemoryScope {
  tenantId: string;
  projectId?: string;
  agentId?: string;
  threadId?: string;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  level: MemoryLevel;
  term: MemoryTerm;
  kind: string; // summary | correction | preference | message | fact | ...
  text: string;
  metadata?: Record<string, unknown>;
  source?: { taskId?: string };
  createdAt: Date;
  expiresAt?: Date | null;
  /** Set by recall: blended relevance score in [0,1]. */
  score?: number;
}

export type NewMemoryItem = {
  scope: MemoryScope;
  level: MemoryLevel;
  term: MemoryTerm;
  kind: string;
  text: string;
  metadata?: Record<string, unknown>;
  source?: { taskId?: string };
  /** For short-term items: time-to-live; sets expiresAt = now + ttlMs. */
  ttlMs?: number;
};

export interface RecallQuery {
  query: string;
  scope: MemoryScope;
  /** Which scope levels to include; default: all applicable. */
  levels?: MemoryLevel[];
  limit?: number;
  tokenBudget?: number;
}

/**
 * Swappable memory backend. recall searches BOTH terms and unions all applicable
 * scope levels (tenant + project + agent + thread), ranking relevance with recency.
 */
export interface MemoryStore {
  remember(item: NewMemoryItem): Promise<MemoryItem>;
  recall(q: RecallQuery): Promise<MemoryItem[]>;
  forget(filter: { id?: string; scope?: Partial<MemoryScope>; before?: Date }): Promise<number>;
  list(scope: Partial<MemoryScope>): Promise<MemoryItem[]>;
  close?(): Promise<void>;
}

/** Text → vector. Implementations: FakeEmbedder (deterministic), OpenAIEmbedder (real). */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}
