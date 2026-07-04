import { describe, expect, it } from "vitest";
import { itemRecallable, recallableLevels, validateWrite } from "../src/audience";
import { FakeEmbedder } from "../src/embedder";
import { FakeMemoryStore } from "../src/fake-store";
import { promoteMemory, rememberCorrection } from "../src/feedback";
import { audienceForTask, resolveProjectId, scopeForTask } from "../src/project";
import { cosine } from "../src/score";
import type { TaskAudience } from "../src/types";

const T = "tenant-1";
const DM: TaskAudience = { level: "user", userId: "u1" };
const PROJECT: TaskAudience = { level: "project", projectId: "o/repo", userId: "u1" };
const TENANT: TaskAudience = { level: "tenant", userId: "u1" };

describe("FakeEmbedder", () => {
  it("gives shared-token texts higher cosine than unrelated ones", async () => {
    const e = new FakeEmbedder();
    const q = await e.embed("why did checkout errors spike");
    const related = await e.embed("checkout errors are caused by PR 4812");
    const unrelated = await e.embed("the cafeteria menu changed today");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});

async function seededStore() {
  const store = new FakeMemoryStore();
  await store.remember({ scope: { tenantId: T, userId: "u1" }, level: "user", term: "long", kind: "correction", text: "For checkout errors, always check PR 4812 first.", agentId: "bruce" });
  await store.remember({ scope: { tenantId: T, userId: "u1" }, level: "user", term: "long", kind: "preference", text: "Prefers checkout summaries as bullet points." });
  await store.remember({ scope: { tenantId: T, projectId: "o/repo" }, level: "project", term: "long", kind: "fact", text: "o/repo guards the checkout payment retry path." });
  await store.remember({ scope: { tenantId: T }, level: "tenant", term: "long", kind: "fact", text: "Checkout deploys happen on Tuesdays.", provenance: { confirmedBy: "admin" } });
  await store.remember({ scope: { tenantId: T, threadId: "th1" }, level: "thread", term: "short", kind: "message", text: "user asked about checkout", ttlMs: 60_000 });
  return store;
}

describe("audience-gated recall (§7.12)", () => {
  const scope = { tenantId: T, projectId: "o/repo", userId: "u1", threadId: "th1" };

  it("DM audience unions user + project + tenant + thread", async () => {
    const store = await seededStore();
    const hits = await store.recall({ query: "checkout errors", scope, audience: DM, limit: 10 });
    expect(new Set(hits.map((h) => h.level))).toEqual(new Set(["user", "project", "tenant", "thread"]));
  });

  it("project audience excludes user content but keeps the preference exception", async () => {
    const store = await seededStore();
    const hits = await store.recall({ query: "checkout errors", scope, audience: PROJECT, limit: 10 });
    expect(hits.some((h) => h.kind === "correction")).toBe(false); // user content stays private
    expect(hits.some((h) => h.kind === "preference")).toBe(true); // steers style, not content
    expect(hits.some((h) => h.level === "project")).toBe(true);
    expect(hits.some((h) => h.level === "tenant")).toBe(true);
  });

  it("general-channel (tenant) audience recalls tenant + thread only", async () => {
    const store = await seededStore();
    const hits = await store.recall({ query: "checkout", scope, audience: TENANT, limit: 10 });
    const levels = new Set(hits.filter((h) => h.kind !== "preference").map((h) => h.level));
    expect(levels).toEqual(new Set(["tenant", "thread"]));
  });

  it("external audiences recall nothing", async () => {
    const store = await seededStore();
    const hits = await store.recall({ query: "checkout", scope, audience: { ...PROJECT, external: true }, limit: 10 });
    expect(hits).toHaveLength(0);
  });

  it("enforces tenant isolation", async () => {
    const store = new FakeMemoryStore();
    await store.remember({ scope: { tenantId: "other" }, level: "tenant", term: "long", kind: "fact", text: "secret from another tenant about checkout", provenance: { confirmedBy: "x" } });
    expect(await store.recall({ query: "checkout", scope: { tenantId: T }, audience: TENANT })).toHaveLength(0);
  });

  it("excludes expired short-term items", async () => {
    let t = 1000;
    const store = new FakeMemoryStore(new FakeEmbedder(), { now: () => t });
    await store.remember({ scope: { tenantId: T, threadId: "th1" }, level: "thread", term: "short", kind: "message", text: "checkout ping", ttlMs: 100 });
    t = 2000; // past TTL
    expect(await store.recall({ query: "checkout", scope: { tenantId: T, threadId: "th1" }, audience: TENANT })).toHaveLength(0);
  });

  it("boosts items tagged with the invoking agent — but never gates on it", async () => {
    const store = new FakeMemoryStore();
    const s = { tenantId: T, projectId: "o/repo" };
    await store.remember({ scope: s, level: "project", term: "long", kind: "fact", text: "checkout errors note one", agentId: "quill" });
    await store.remember({ scope: s, level: "project", term: "long", kind: "fact", text: "checkout errors note two", agentId: "bruce" });
    const hits = await store.recall({ query: "checkout errors note", scope: s, audience: PROJECT, agentId: "bruce", limit: 5 });
    expect(hits[0]!.agentId).toBe("bruce"); // boosted to the top
    expect(hits.map((h) => h.agentId).sort()).toEqual(["bruce", "quill"]); // quill's still recallable
  });

  it("respects the token budget", async () => {
    const store = await seededStore();
    const hits = await store.recall({ query: "checkout", scope, audience: DM, limit: 10, tokenBudget: 12 });
    expect(hits.length).toBeGreaterThanOrEqual(1); // always at least the top item
    expect(hits.length).toBeLessThan(5);
  });
});

describe("write gating (§7.12)", () => {
  it("tenant-scoped writes require confirmation", async () => {
    const store = new FakeMemoryStore();
    await expect(
      store.remember({ scope: { tenantId: T }, level: "tenant", term: "long", kind: "fact", text: "x" }),
    ).rejects.toThrow(/confirmedBy/);
  });
  it("items must carry the scope key their level names", async () => {
    const store = new FakeMemoryStore();
    await expect(store.remember({ scope: { tenantId: T }, level: "user", term: "long", kind: "fact", text: "x" })).rejects.toThrow(/scope.userId/);
    await expect(store.remember({ scope: { tenantId: T }, level: "project", term: "long", kind: "fact", text: "x" })).rejects.toThrow(/scope.projectId/);
    await expect(store.remember({ scope: { tenantId: T }, level: "thread", term: "long", kind: "fact", text: "x" })).rejects.toThrow(/scope.threadId/);
  });
});

describe("feedback → memory (OQ-3)", () => {
  it("writes a user-scoped correction tagged with the agent", async () => {
    const store = new FakeMemoryStore();
    const r = await rememberCorrection(store, { tenantId: T, userId: "u1" }, "Prefer concise summaries.", { agentId: "bruce" });
    expect(r).toMatchObject({ level: "user", kind: "correction", agentId: "bruce" });
    expect((await store.list({ tenantId: T, userId: "u1" }))[0]!.kind).toBe("correction");
  });
  it("no-ops without a requestor or text", async () => {
    const store = new FakeMemoryStore();
    expect(await rememberCorrection(store, { tenantId: T }, "x")).toBeNull();
    expect(await rememberCorrection(store, { tenantId: T, userId: "u1" }, "  ")).toBeNull();
  });
  it("promotes to project scope, replacing the narrow item", async () => {
    const store = new FakeMemoryStore();
    const item = (await rememberCorrection(store, { tenantId: T, userId: "u1", projectId: "o/repo" }, "Check PR 4812 first."))!;
    const promoted = await promoteMemory(store, item, "project");
    expect(promoted).toMatchObject({ level: "project", scope: { projectId: "o/repo" } });
    expect(promoted.provenance?.promotedFrom).toBe(item.id);
    expect(await store.list({ tenantId: T, userId: "u1" })).toHaveLength(0); // original replaced
  });
  it("rolls back the broad copy when deleting the original fails", async () => {
    const store = new FakeMemoryStore();
    const item = (await rememberCorrection(store, { tenantId: T, userId: "u1", projectId: "o/repo" }, "Check PR 4812 first."))!;
    const failingForget = store.forget.bind(store);
    store.forget = async (filter) => {
      if (filter.id === item.id) throw new Error("backend down");
      return failingForget(filter);
    };
    await expect(promoteMemory(store, item, "project")).rejects.toThrow("backend down");
    const remaining = await store.list({ tenantId: T });
    expect(remaining).toHaveLength(1); // only the narrow original — no broad duplicate
    expect(remaining[0]!.level).toBe("user");
  });
  it("promotion to tenant scope requires confirmation", async () => {
    const store = new FakeMemoryStore();
    const item = (await rememberCorrection(store, { tenantId: T, userId: "u1" }, "Check PR 4812 first."))!;
    await expect(promoteMemory(store, item, "tenant")).rejects.toThrow(/confirmedBy/);
    const promoted = await promoteMemory(store, item, "tenant", { confirmedBy: "owner-1" });
    expect(promoted).toMatchObject({ level: "tenant", provenance: { confirmedBy: "owner-1" } });
  });
});

describe("scope + audience computation", () => {
  it("uses the GitHub repo as the project", () => {
    expect(resolveProjectId("github", { repo: "o/r" })).toBe("o/r");
    expect(resolveProjectId("slack", { channel: "C1" })).toBe("slack:C1");
    expect(resolveProjectId("slack", {})).toBeUndefined();
  });
  it("scopeForTask derives project, user, and thread (incl. Slack thread_ts)", () => {
    expect(scopeForTask({ tenantId: T, invokingUserId: "u1", sourceType: "github", sourceRef: { repo: "o/r", number: 7 } }))
      .toMatchObject({ tenantId: T, userId: "u1", projectId: "o/r", threadId: "o/r#7" });
    expect(scopeForTask({ tenantId: T, sourceType: "slack", sourceRef: { channel: "C1", thread_ts: "111.222" } }))
      .toMatchObject({ projectId: "slack:C1", threadId: "111.222" });
  });
  it("audienceForTask: repo → project; DM → user; unmapped → tenant", () => {
    expect(audienceForTask({ tenantId: T, invokingUserId: "u1", sourceType: "github", sourceRef: { repo: "o/r" } }))
      .toMatchObject({ level: "project", projectId: "o/r", userId: "u1" });
    expect(audienceForTask({ tenantId: T, invokingUserId: "u1", sourceType: "slack", sourceRef: { channel: "D123" } }))
      .toMatchObject({ level: "user", userId: "u1" });
    expect(audienceForTask({ tenantId: T, invokingUserId: "u1", sourceType: "slack", sourceRef: { channel: "C9" } }))
      .toMatchObject({ level: "project", projectId: "slack:C9" });
    expect(audienceForTask({ tenantId: T, sourceType: "api" })).toMatchObject({ level: "tenant" });
  });
});

describe("audience containment rules", () => {
  it("recallableLevels follows the §7.12 table", () => {
    expect(recallableLevels(DM)).toEqual(["user", "project", "tenant", "thread"]);
    expect(recallableLevels(PROJECT)).toEqual(["project", "tenant", "thread"]);
    expect(recallableLevels(TENANT)).toEqual(["tenant", "thread"]);
    expect(recallableLevels({ ...PROJECT, external: true })).toEqual([]);
  });
  it("itemRecallable matches scope keys within a level", () => {
    const scope = { tenantId: T, projectId: "o/r", userId: "u1", threadId: "t1" };
    expect(itemRecallable({ level: "project", kind: "fact", scope: { tenantId: T, projectId: "o/r" } }, scope, PROJECT)).toBe(true);
    expect(itemRecallable({ level: "project", kind: "fact", scope: { tenantId: T, projectId: "x" } }, scope, PROJECT)).toBe(false);
    expect(itemRecallable({ level: "user", kind: "correction", scope: { tenantId: T, userId: "u1" } }, scope, PROJECT)).toBe(false);
    expect(itemRecallable({ level: "user", kind: "preference", scope: { tenantId: T, userId: "u1" } }, scope, PROJECT)).toBe(true);
    expect(itemRecallable({ level: "tenant", kind: "fact", scope: { tenantId: "other" } }, scope, TENANT)).toBe(false);
  });
  it("validateWrite enforces narrowest-scope keys", () => {
    expect(() => validateWrite({ scope: { tenantId: T, userId: "u1" }, level: "user", term: "long", kind: "fact", text: "x" })).not.toThrow();
    expect(() => validateWrite({ scope: { tenantId: T }, level: "tenant", term: "long", kind: "fact", text: "x" })).toThrow();
  });
});
