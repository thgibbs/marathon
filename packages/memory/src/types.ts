/**
 * Memory model — design §7.12 (scope × term, searched together).
 *
 * Scopes are AUDIENCES (nested user ⊂ project ⊂ tenant, plus per-conversation
 * thread). A named agent is NOT a scope: `agentId` is relevance metadata that
 * boosts ranking for that agent's tasks and never filters access (Track 13,
 * OQ-3 resolution).
 */
export type MemoryTerm = "short" | "long";
export type MemoryLevel = "tenant" | "project" | "user" | "thread";

export interface MemoryScope {
  tenantId: string;
  /** A GitHub repo "owner/name" (or a Slack channel stand-in) — see project.ts. */
  projectId?: string;
  /** The requesting user (app_user id). */
  userId?: string;
  threadId?: string;
}

/**
 * Who will see the task's output, computed deterministically at prompt-build
 * (§7.12: repo audience on GitHub; DM detection + channel↔project mapping on
 * Slack — no content classification). Recall is audience-gated: a scope is
 * recallable iff the task's audience is contained in the scope's audience.
 */
export interface TaskAudience {
  level: MemoryLevel;
  projectId?: string;
  /** The requestor — enables the user-`preference` recall exception. */
  userId?: string;
  /** External/guest members present → no memory enters the prompt. */
  external?: boolean;
}

/** What produced an item and how sensitive its content is (write-side record). */
export interface MemoryProvenance {
  taskId?: string;
  /** Content sensitivity — feeds narrowest-scope enforcement + egress accounting (§7.8). */
  sensitivity?: string;
  /** Who confirmed a tenant-scoped write (the §7.12 write gate). */
  confirmedBy?: string;
  /** The narrower item this one was promoted from (feedback.ts). */
  promotedFrom?: string;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  level: MemoryLevel;
  term: MemoryTerm;
  kind: string; // summary | correction | preference | message | fact | ...
  /** Relevance metadata only — boosts ranking for that agent's tasks, never an access filter. */
  agentId?: string;
  text: string;
  metadata?: Record<string, unknown>;
  provenance?: MemoryProvenance;
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
  agentId?: string;
  metadata?: Record<string, unknown>;
  provenance?: MemoryProvenance;
  /** For short-term items: time-to-live; sets expiresAt = now + ttlMs. */
  ttlMs?: number;
};

export interface RecallQuery {
  query: string;
  scope: MemoryScope;
  /** The task's audience — gates which levels may enter the prompt (§7.12). */
  audience: TaskAudience;
  /** The invoking agent — matching items rank higher (never an access filter). */
  agentId?: string;
  limit?: number;
  /** Approximate prompt-token cap over the returned items' text. */
  tokenBudget?: number;
}

/**
 * Swappable memory backend. `remember` enforces narrowest-scope + write
 * gating (tenant writes need confirmation); `recall` searches BOTH terms,
 * unions the audience-recallable scopes, and ranks relevance blended with
 * recency (agent tags boost relevance).
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
