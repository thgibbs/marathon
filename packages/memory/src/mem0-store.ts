import type { MemoryItem, MemoryLevel, MemoryScope, MemoryStore, NewMemoryItem, RecallQuery } from "./types";

/**
 * Mem0 adapter (first external backend). Maps Marathon's scope to Mem0's keys:
 *   tenant -> user_id (namespace) · agent -> agent_id · thread -> run_id
 *   project/level/term/kind -> metadata (and metadata filters on search).
 *
 * Talks to a Mem0 service over HTTP (hosted api.mem0.ai or self-hosted) — the Python
 * library is not embedded in-process. Best-effort / smoke-validated; extraction &
 * consolidation are Mem0-side and out of scope for M7's store-and-retrieve cut.
 */
export class Mem0MemoryStore implements MemoryStore {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.mem0.ai/v1",
  ) {}

  private async api(path: string, body: unknown, method = "POST"): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mem0 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }

  async remember(input: NewMemoryItem): Promise<MemoryItem> {
    const j = (await this.api("/memories/", {
      messages: [{ role: "user", content: input.text }],
      user_id: input.scope.tenantId,
      agent_id: input.scope.agentId,
      run_id: input.scope.threadId,
      metadata: { level: input.level, term: input.term, kind: input.kind, projectId: input.scope.projectId, ...input.metadata },
    })) as { id?: string; results?: Array<{ id: string }> };
    const id = j.id ?? j.results?.[0]?.id ?? `mem0-${Date.now()}`;
    return { id, scope: input.scope, level: input.level, term: input.term, kind: input.kind, text: input.text, metadata: input.metadata, source: input.source, createdAt: new Date(), expiresAt: null };
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const j = (await this.api("/memories/search/", {
      query: q.query,
      user_id: q.scope.tenantId,
      agent_id: q.scope.agentId,
      run_id: q.scope.threadId,
      limit: q.limit ?? 8,
    })) as { results?: Array<{ id: string; memory?: string; text?: string; score?: number; metadata?: Record<string, unknown> }> };
    return (j.results ?? []).map((r) => ({
      id: r.id,
      scope: q.scope,
      level: (r.metadata?.level as MemoryLevel) ?? "agent",
      term: (r.metadata?.term as "short" | "long") ?? "long",
      kind: (r.metadata?.kind as string) ?? "fact",
      text: r.memory ?? r.text ?? "",
      metadata: r.metadata,
      createdAt: new Date(),
      expiresAt: null,
      score: r.score,
    }));
  }

  async forget(filter: { id?: string }): Promise<number> {
    if (!filter.id) throw new Error("mem0 forget currently supports id only");
    await this.api(`/memories/${filter.id}/`, null, "DELETE");
    return 1;
  }

  async list(scope: Partial<MemoryScope>): Promise<MemoryItem[]> {
    const params = new URLSearchParams();
    if (scope.tenantId) params.set("user_id", scope.tenantId);
    if (scope.agentId) params.set("agent_id", scope.agentId);
    const j = (await this.api(`/memories/?${params.toString()}`, null, "GET")) as {
      results?: Array<{ id: string; memory?: string; metadata?: Record<string, unknown> }>;
    };
    return (j.results ?? []).map((r) => ({
      id: r.id,
      scope: scope as MemoryScope,
      level: (r.metadata?.level as MemoryLevel) ?? "agent",
      term: (r.metadata?.term as "short" | "long") ?? "long",
      kind: (r.metadata?.kind as string) ?? "fact",
      text: r.memory ?? "",
      metadata: r.metadata,
      createdAt: new Date(),
      expiresAt: null,
    }));
  }
}
