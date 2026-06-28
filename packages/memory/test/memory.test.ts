import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder";
import { FakeMemoryStore } from "../src/fake-store";
import { rememberCorrection } from "../src/feedback";
import { resolveProjectId, scopeForTask } from "../src/project";
import { cosine, scopeMatches } from "../src/score";

const T = "tenant-1";

describe("FakeEmbedder", () => {
  it("gives shared-token texts higher cosine than unrelated ones", async () => {
    const e = new FakeEmbedder();
    const q = await e.embed("why did checkout errors spike");
    const related = await e.embed("checkout errors are caused by PR 4812");
    const unrelated = await e.embed("the cafeteria menu changed today");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});

describe("FakeMemoryStore recall", () => {
  it("unions scopes, searches both terms, and ranks the correction first", async () => {
    const store = new FakeMemoryStore();
    const scope = { tenantId: T, projectId: "o/repo", agentId: "bruce", threadId: "th1" };
    await store.remember({ scope: { tenantId: T, agentId: "bruce" }, level: "agent", term: "long", kind: "correction", text: "For checkout errors, always check PR 4812 first." });
    await store.remember({ scope: { tenantId: T }, level: "tenant", term: "long", kind: "fact", text: "We deploy on Tuesdays." });
    await store.remember({ scope: { tenantId: T, threadId: "th1" }, level: "thread", term: "short", kind: "message", text: "user asked about checkout", ttlMs: 60_000 });

    const hits = await store.recall({ query: "why did checkout errors spike", scope, limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.kind).toBe("correction");
  });

  it("enforces tenant isolation and scope matching", async () => {
    const store = new FakeMemoryStore();
    await store.remember({ scope: { tenantId: "other", agentId: "bruce" }, level: "agent", term: "long", kind: "correction", text: "secret from another tenant about checkout" });
    const hits = await store.recall({ query: "checkout", scope: { tenantId: T, agentId: "bruce" } });
    expect(hits).toHaveLength(0);
  });

  it("excludes expired short-term items", async () => {
    let t = 1000;
    const store = new FakeMemoryStore(new FakeEmbedder(), { now: () => t });
    await store.remember({ scope: { tenantId: T, threadId: "th1" }, level: "thread", term: "short", kind: "message", text: "checkout ping", ttlMs: 100 });
    t = 2000; // past TTL
    expect(await store.recall({ query: "checkout", scope: { tenantId: T, threadId: "th1" } })).toHaveLength(0);
  });

  it("forget removes by scope; list is scope-filtered", async () => {
    const store = new FakeMemoryStore();
    await store.remember({ scope: { tenantId: T, agentId: "bruce" }, level: "agent", term: "long", kind: "fact", text: "a" });
    expect(await store.list({ tenantId: T })).toHaveLength(1);
    expect(await store.forget({ scope: { tenantId: T, agentId: "bruce" } })).toBe(1);
    expect(await store.list({ tenantId: T })).toHaveLength(0);
  });
});

describe("feedback → memory", () => {
  it("writes an agent-scoped correction", async () => {
    const store = new FakeMemoryStore();
    const r = await rememberCorrection(store, { tenantId: T, agentId: "bruce" }, "Prefer concise summaries.");
    expect(r).not.toBeNull();
    const items = await store.list({ tenantId: T, agentId: "bruce" });
    expect(items[0]!.kind).toBe("correction");
  });
  it("no-ops without an agent or text", async () => {
    const store = new FakeMemoryStore();
    expect(await rememberCorrection(store, { tenantId: T }, "x")).toBeNull();
    expect(await rememberCorrection(store, { tenantId: T, agentId: "bruce" }, "  ")).toBeNull();
  });
});

describe("project resolver", () => {
  it("uses the GitHub repo as the project", () => {
    expect(resolveProjectId("github", { repo: "o/r" })).toBe("o/r");
    expect(resolveProjectId("slack", { channel: "C1" })).toBe("slack:C1");
    expect(resolveProjectId("slack", {})).toBeUndefined();
  });
  it("scopeForTask derives project + thread", () => {
    const s = scopeForTask({ tenantId: T, agentId: "a1", sourceType: "github", sourceRef: { repo: "o/r", number: 7 } });
    expect(s).toMatchObject({ tenantId: T, agentId: "a1", projectId: "o/r", threadId: "o/r#7" });
  });
});

describe("scopeMatches", () => {
  it("tenant always; project/agent/thread require a matching key", () => {
    const q = { tenantId: T, projectId: "o/r", agentId: "a1", threadId: "t1" };
    expect(scopeMatches({ tenantId: T }, "tenant", q)).toBe(true);
    expect(scopeMatches({ tenantId: T, projectId: "o/r" }, "project", q)).toBe(true);
    expect(scopeMatches({ tenantId: T, projectId: "x" }, "project", q)).toBe(false);
    expect(scopeMatches({ tenantId: "other" }, "tenant", q)).toBe(false);
  });
});
