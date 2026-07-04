import { afterEach, describe, expect, it, vi } from "vitest";
import { Mem0MemoryStore } from "../src/mem0-store";

const T = "tenant-1";

/** Stub fetch capturing request bodies and returning canned Mem0 responses. */
function stubMem0(searchResults: Array<Record<string, unknown>>) {
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      const payload = path.endsWith("/search/") ? { results: searchResults } : { id: "mem0-1" };
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return calls;
}

function searchResult(text: string, md: Record<string, unknown>): Record<string, unknown> {
  return { id: `r-${text}`, memory: text, metadata: md };
}

afterEach(() => vi.unstubAllGlobals());

describe("Mem0MemoryStore", () => {
  it("caller metadata cannot spoof the store-owned audience fields", async () => {
    const calls = stubMem0([]);
    const store = new Mem0MemoryStore("key");
    await store.remember({
      scope: { tenantId: T, userId: "u1" },
      level: "user",
      term: "long",
      kind: "correction",
      text: "check PR 4812",
      // A poisoned write trying to broaden its own audience:
      metadata: { level: "tenant", userId: "attacker", projectId: "o/other", threadId: "th-x", note: "kept" },
    });
    const md = calls[0]!.body!.metadata as Record<string, unknown>;
    expect(md.level).toBe("user");
    expect(md.userId).toBe("u1");
    expect(md.projectId).toBeUndefined(); // spoofed key erased, not preserved
    expect(md.threadId).toBeUndefined();
    expect(md.note).toBe("kept"); // benign caller metadata survives
  });

  it("over-fetches, gates by audience, then applies limit + token budget", async () => {
    // Two other users' items outrank the requestor's: a limit-sized fetch
    // would return only gated-out hits.
    const calls = stubMem0([
      searchResult("private A", { level: "user", userId: "other-1" }),
      searchResult("private B", { level: "user", userId: "other-2" }),
      searchResult("mine one mine one mine one", { level: "user", userId: "u1" }),
      searchResult("mine two", { level: "user", userId: "u1" }),
    ]);
    const store = new Mem0MemoryStore("key");
    const q = { query: "anything", scope: { tenantId: T, userId: "u1" }, audience: { level: "user" as const, userId: "u1" } };

    const hits = await store.recall({ ...q, limit: 2 });
    expect(calls[0]!.body!.limit).toBe(6); // 3x over-fetch, not the raw limit
    expect(hits.map((h) => h.text)).toEqual(["mine one mine one mine one", "mine two"]);

    const budgeted = await store.recall({ ...q, limit: 2, tokenBudget: 5 });
    expect(budgeted.map((h) => h.text)).toEqual(["mine one mine one mine one"]); // budget cuts the second
  });
});
