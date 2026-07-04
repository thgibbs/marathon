import { itemRecallable, validateWrite } from "./audience";
import { capResults } from "./score";
import type { MemoryItem, MemoryLevel, MemoryScope, MemoryStore, NewMemoryItem, RecallQuery } from "./types";

/**
 * Mem0 adapter (first external backend). Maps Marathon's scope to Mem0's keys:
 *   tenant -> user_id (the namespace) · agent tag -> agent_id · thread -> run_id
 *   project/user/level/term/kind -> metadata (recall re-applies the §7.12
 *   audience gate client-side from that metadata).
 *
 * Talks to a Mem0 service over HTTP (hosted api.mem0.ai or self-hosted) — the Python
 * library is not embedded in-process. Best-effort / smoke-validated; extraction &
 * consolidation are Mem0-side and out of scope for the store-and-retrieve cut.
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
    validateWrite(input);
    const j = (await this.api("/memories/", {
      messages: [{ role: "user", content: input.text }],
      user_id: input.scope.tenantId,
      agent_id: input.agentId,
      run_id: input.scope.threadId,
      // Store-owned audience fields come LAST: recall reconstructs the item's
      // scope from this metadata, so caller metadata must never be able to
      // spoof level/projectId/userId/threadId into a broader audience.
      metadata: {
        ...input.metadata,
        level: input.level,
        term: input.term,
        kind: input.kind,
        projectId: input.scope.projectId,
        userId: input.scope.userId,
        threadId: input.scope.threadId,
      },
    })) as { id?: string; results?: Array<{ id: string }> };
    const id = j.id ?? j.results?.[0]?.id ?? `mem0-${Date.now()}`;
    return {
      id,
      scope: input.scope,
      level: input.level,
      term: input.term,
      kind: input.kind,
      agentId: input.agentId,
      text: input.text,
      metadata: input.metadata,
      provenance: input.provenance,
      createdAt: new Date(),
      expiresAt: null,
    };
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    if (q.audience.external) return [];
    const limit = q.limit ?? 8;
    // Search the whole tenant namespace (a run_id filter would exclude
    // long-term items); the audience gate below does the scoping. Over-fetch
    // like the pgvector store so gated-out top hits don't starve the result,
    // then cap by limit + token budget AFTER gating.
    const j = (await this.api("/memories/search/", {
      query: q.query,
      user_id: q.scope.tenantId,
      limit: Math.max(limit * 3, limit),
    })) as { results?: Array<{ id: string; memory?: string; text?: string; score?: number; agent_id?: string; metadata?: Record<string, unknown> }> };
    const recallable = (j.results ?? [])
      .map((r) => itemFromResult(r, q.scope.tenantId))
      .filter((it) => itemRecallable(it, q.scope, q.audience));
    return capResults(recallable, limit, q.tokenBudget);
  }

  async forget(filter: { id?: string }): Promise<number> {
    if (!filter.id) throw new Error("mem0 forget currently supports id only");
    await this.api(`/memories/${filter.id}/`, null, "DELETE");
    return 1;
  }

  async list(scope: Partial<MemoryScope>): Promise<MemoryItem[]> {
    const params = new URLSearchParams();
    if (scope.tenantId) params.set("user_id", scope.tenantId);
    const j = (await this.api(`/memories/?${params.toString()}`, null, "GET")) as {
      results?: Array<{ id: string; memory?: string; agent_id?: string; metadata?: Record<string, unknown> }>;
    };
    return (j.results ?? [])
      .map((r) => itemFromResult(r, scope.tenantId ?? ""))
      .filter((it) => (scope.projectId === undefined || it.scope.projectId === scope.projectId) && (scope.userId === undefined || it.scope.userId === scope.userId));
  }
}

function itemFromResult(
  r: { id: string; memory?: string; text?: string; score?: number; agent_id?: string; metadata?: Record<string, unknown> },
  tenantId: string,
): MemoryItem {
  const md = r.metadata ?? {};
  return {
    id: r.id,
    scope: {
      tenantId,
      projectId: (md.projectId as string) ?? undefined,
      userId: (md.userId as string) ?? undefined,
      threadId: (md.threadId as string) ?? undefined,
    },
    // Items written before the audience migration (or by other clients) may
    // lack a level; treat them as tenant-wide, the old union behavior.
    level: (md.level as MemoryLevel) ?? "tenant",
    term: (md.term as "short" | "long") ?? "long",
    kind: (md.kind as string) ?? "fact",
    agentId: r.agent_id ?? undefined,
    text: r.memory ?? r.text ?? "",
    metadata: r.metadata,
    createdAt: new Date(),
    expiresAt: null,
    score: r.score,
  };
}
