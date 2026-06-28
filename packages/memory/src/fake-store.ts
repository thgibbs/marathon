import { FakeEmbedder } from "./embedder";
import { blendedScore, cosine, isExpired, recencyWeight, scopeMatches } from "./score";
import type { Embedder, MemoryItem, MemoryLevel, MemoryScope, MemoryStore, NewMemoryItem, RecallQuery } from "./types";

const LEVELS: MemoryLevel[] = ["tenant", "project", "agent", "thread"];

/** In-memory MemoryStore for unit tests/CI — same semantics as the pgvector store. */
export class FakeMemoryStore implements MemoryStore {
  private readonly items: MemoryItem[] = [];
  private readonly vectors = new Map<string, number[]>();
  private seq = 0;
  private readonly now: () => number;

  constructor(
    private readonly embedder: Embedder = new FakeEmbedder(),
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async remember(input: NewMemoryItem): Promise<MemoryItem> {
    const id = `mem-${++this.seq}`;
    const createdAt = new Date(this.now());
    const item: MemoryItem = {
      id,
      scope: input.scope,
      level: input.level,
      term: input.term,
      kind: input.kind,
      text: input.text,
      metadata: input.metadata,
      source: input.source,
      createdAt,
      expiresAt: input.ttlMs != null ? new Date(this.now() + input.ttlMs) : null,
    };
    this.items.push(item);
    this.vectors.set(id, await this.embedder.embed(input.text));
    return item;
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const now = this.now();
    const levels = q.levels ?? LEVELS;
    const qvec = await this.embedder.embed(q.query);
    const scored = this.items
      .filter((it) => levels.includes(it.level) && scopeMatches(it.scope, it.level, q.scope) && !isExpired(it, now))
      .map((it) => {
        const sim = cosine(qvec, this.vectors.get(it.id) ?? []);
        const score = blendedScore(sim, recencyWeight(it.createdAt, now));
        return { ...it, score };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored.slice(0, q.limit ?? 8);
  }

  async forget(filter: { id?: string; scope?: Partial<MemoryScope>; before?: Date }): Promise<number> {
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (filter.id && it.id !== filter.id) continue;
      if (filter.before && it.createdAt >= filter.before) continue;
      if (filter.scope && !partialScopeMatch(it.scope, filter.scope)) continue;
      this.items.splice(i, 1);
      this.vectors.delete(it.id);
      removed++;
    }
    return removed;
  }

  async list(scope: Partial<MemoryScope>): Promise<MemoryItem[]> {
    return this.items
      .filter((it) => partialScopeMatch(it.scope, scope))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

function partialScopeMatch(itemScope: MemoryScope, filter: Partial<MemoryScope>): boolean {
  return (Object.keys(filter) as Array<keyof MemoryScope>).every((k) => filter[k] === undefined || itemScope[k] === filter[k]);
}
