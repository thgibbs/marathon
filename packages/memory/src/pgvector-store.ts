import pg from "pg";
import { recallableLevels, validateWrite } from "./audience";
import { FakeEmbedder } from "./embedder";
import { blendedScore, capResults, isExpired, recencyWeight } from "./score";
import type { Embedder, MemoryItem, MemoryLevel, MemoryProvenance, MemoryScope, MemoryStore, NewMemoryItem, RecallQuery } from "./types";

const { Pool } = pg;

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Default MemoryStore: Postgres + pgvector (design §7.12). Embeddings are pluggable. */
export class PgVectorMemoryStore implements MemoryStore {
  private readonly pool: pg.Pool;
  constructor(
    databaseUrl: string,
    private readonly embedder: Embedder = new FakeEmbedder(),
  ) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async remember(input: NewMemoryItem): Promise<MemoryItem> {
    validateWrite(input);
    const embedding = vecLiteral(await this.embedder.embed(input.text));
    const expiresAt = input.ttlMs != null ? new Date(Date.now() + input.ttlMs) : null;
    const { rows } = await this.pool.query(
      `insert into memory_item(tenant_id, project_id, user_id, thread_id, agent_id, level, term, kind, text, metadata, provenance, embedding, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector,$13) returning *`,
      [
        input.scope.tenantId,
        input.scope.projectId ?? null,
        input.scope.userId ?? null,
        input.scope.threadId ?? null,
        input.agentId ?? null,
        input.level,
        input.term,
        input.kind,
        input.text,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.provenance ?? {}),
        embedding,
        expiresAt,
      ],
    );
    return rowToItem(rows[0]);
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    // Audience gating (§7.12): only levels whose audience contains the
    // task's audience enter the search; within a level the query's scope
    // key must match. The user-`preference` exception rides as its own clause.
    const levels = recallableLevels(q.audience);
    const scopeClauses: string[] = [];
    const params: unknown[] = [q.scope.tenantId];
    if (levels.includes("tenant")) scopeClauses.push(`level = 'tenant'`);
    if (levels.includes("project") && q.scope.projectId) {
      params.push(q.scope.projectId);
      scopeClauses.push(`(level = 'project' and project_id = $${params.length})`);
    }
    if (levels.includes("user") && q.scope.userId) {
      params.push(q.scope.userId);
      scopeClauses.push(`(level = 'user' and user_id = $${params.length})`);
    } else if (!q.audience.external && q.audience.userId) {
      params.push(q.audience.userId);
      scopeClauses.push(`(level = 'user' and user_id = $${params.length} and kind = 'preference')`);
    }
    if (levels.includes("thread") && q.scope.threadId) {
      params.push(q.scope.threadId);
      scopeClauses.push(`(level = 'thread' and thread_id = $${params.length})`);
    }
    if (scopeClauses.length === 0) return [];

    const qvec = vecLiteral(await this.embedder.embed(q.query));
    params.push(qvec);
    const qIdx = params.length;
    const limit = q.limit ?? 8;
    const { rows } = await this.pool.query(
      `select *, embedding <=> $${qIdx}::vector as distance
       from memory_item
       where tenant_id = $1
         and (${scopeClauses.join(" or ")})
         and (expires_at is null or expires_at > now())
       order by distance asc
       limit ${Math.max(limit * 3, limit)}`,
      params,
    );

    const now = Date.now();
    const ranked = rows
      .map((r: Record<string, unknown>) => {
        const item = rowToItem(r);
        const similarity = 1 - Number(r.distance ?? 1); // cosine distance -> similarity
        item.score = blendedScore(similarity, recencyWeight(item.createdAt, now), !!q.agentId && item.agentId === q.agentId);
        return item;
      })
      .filter((it) => !isExpired(it, now))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return capResults(ranked, limit, q.tokenBudget);
  }

  async forget(filter: { id?: string; scope?: Partial<MemoryScope>; before?: Date }): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.id) {
      params.push(filter.id);
      where.push(`id = $${params.length}`);
    }
    if (filter.before) {
      params.push(filter.before);
      where.push(`created_at < $${params.length}`);
    }
    for (const [k, col] of SCOPE_COLUMNS) {
      const v = filter.scope?.[k];
      if (v !== undefined) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    if (where.length === 0) throw new Error("forget requires at least one filter");
    const res = await this.pool.query(`delete from memory_item where ${where.join(" and ")}`, params);
    return res.rowCount ?? 0;
  }

  async list(scope: Partial<MemoryScope>): Promise<MemoryItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of SCOPE_COLUMNS) {
      const v = scope[k];
      if (v !== undefined) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const { rows } = await this.pool.query(`select * from memory_item ${clause} order by created_at desc`, params);
    return rows.map(rowToItem);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const SCOPE_COLUMNS = [
  ["tenantId", "tenant_id"],
  ["projectId", "project_id"],
  ["userId", "user_id"],
  ["threadId", "thread_id"],
] as const;

function rowToItem(r: Record<string, unknown>): MemoryItem {
  return {
    id: r.id as string,
    scope: {
      tenantId: r.tenant_id as string,
      projectId: (r.project_id as string) ?? undefined,
      userId: (r.user_id as string) ?? undefined,
      threadId: (r.thread_id as string) ?? undefined,
    },
    level: r.level as MemoryLevel,
    term: r.term as "short" | "long",
    kind: r.kind as string,
    agentId: (r.agent_id as string) ?? undefined,
    text: r.text as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    provenance: (r.provenance as MemoryProvenance) ?? {},
    createdAt: r.created_at as Date,
    expiresAt: (r.expires_at as Date) ?? null,
  };
}
