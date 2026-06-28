import pg from "pg";
import { FakeEmbedder } from "./embedder";
import { blendedScore, isExpired, recencyWeight } from "./score";
import type { Embedder, MemoryItem, MemoryLevel, MemoryScope, MemoryStore, NewMemoryItem, RecallQuery } from "./types";

const { Pool } = pg;
const LEVELS: MemoryLevel[] = ["tenant", "project", "agent", "thread"];

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
    const embedding = vecLiteral(await this.embedder.embed(input.text));
    const expiresAt = input.ttlMs != null ? new Date(Date.now() + input.ttlMs) : null;
    const { rows } = await this.pool.query(
      `insert into memory_item(tenant_id, project_id, agent_id, thread_id, level, term, kind, text, metadata, source, embedding, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12) returning *`,
      [
        input.scope.tenantId,
        input.scope.projectId ?? null,
        input.scope.agentId ?? null,
        input.scope.threadId ?? null,
        input.level,
        input.term,
        input.kind,
        input.text,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.source ?? {}),
        embedding,
        expiresAt,
      ],
    );
    return rowToItem(rows[0]);
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const levels = q.levels ?? LEVELS;
    const qvec = vecLiteral(await this.embedder.embed(q.query));

    // union of applicable scopes: tenant always; others must match a provided key
    const scopeClauses: string[] = [];
    const params: unknown[] = [q.scope.tenantId];
    if (levels.includes("tenant")) scopeClauses.push(`level = 'tenant'`);
    if (levels.includes("project") && q.scope.projectId) {
      params.push(q.scope.projectId);
      scopeClauses.push(`(level = 'project' and project_id = $${params.length})`);
    }
    if (levels.includes("agent") && q.scope.agentId) {
      params.push(q.scope.agentId);
      scopeClauses.push(`(level = 'agent' and agent_id = $${params.length})`);
    }
    if (levels.includes("thread") && q.scope.threadId) {
      params.push(q.scope.threadId);
      scopeClauses.push(`(level = 'thread' and thread_id = $${params.length})`);
    }
    if (scopeClauses.length === 0) return [];

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
    return rows
      .map((r: Record<string, unknown>) => {
        const item = rowToItem(r);
        const similarity = 1 - Number(r.distance ?? 1); // cosine distance -> similarity
        item.score = blendedScore(similarity, recencyWeight(item.createdAt, now));
        return item;
      })
      .filter((it) => !isExpired(it, now))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
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
    for (const [k, col] of [["tenantId", "tenant_id"], ["projectId", "project_id"], ["agentId", "agent_id"], ["threadId", "thread_id"]] as const) {
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
    for (const [k, col] of [["tenantId", "tenant_id"], ["projectId", "project_id"], ["agentId", "agent_id"], ["threadId", "thread_id"]] as const) {
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

function rowToItem(r: Record<string, unknown>): MemoryItem {
  return {
    id: r.id as string,
    scope: {
      tenantId: r.tenant_id as string,
      projectId: (r.project_id as string) ?? undefined,
      agentId: (r.agent_id as string) ?? undefined,
      threadId: (r.thread_id as string) ?? undefined,
    },
    level: r.level as MemoryLevel,
    term: r.term as "short" | "long",
    kind: r.kind as string,
    text: r.text as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    source: (r.source as { taskId?: string }) ?? {},
    createdAt: r.created_at as Date,
    expiresAt: (r.expires_at as Date) ?? null,
  };
}
