import { parseAgentSpec } from "@marathon/config";
import type { Agent, AgentVersion } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { ensureAgentFromSpec, seedConfiguredAgents, type AgentSeedDb } from "../src/agents";

function makeDb() {
  const agents = new Map<string, Agent>();
  const versions: AgentVersion[] = [];
  let seq = 1;
  const db: AgentSeedDb = {
    async findOrCreateAgent(tenantId, name) {
      const key = `${tenantId}:${name}`;
      const existing = agents.get(key);
      if (existing) return existing;
      const agent: Agent = {
        id: `a${seq++}`,
        tenantId,
        name,
        displayName: null,
        description: null,
        ownerUserId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      agents.set(key, agent);
      return agent;
    },
    async getLatestAgentVersion(agentId) {
      const mine = versions.filter((v) => v.agentId === agentId);
      return mine.sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
    },
    async createAgentVersion(input) {
      const v: AgentVersion = {
        id: `av${seq++}`,
        agentId: input.agentId,
        versionNumber: input.versionNumber,
        status: "published",
        instructions: input.instructions ?? null,
        modelPolicy: null,
        toolPolicy: null,
        memoryPolicy: null,
        approvalPolicy: null,
        createdBy: null,
        createdAt: new Date(),
        publishedAt: new Date(),
      };
      versions.push(v);
      return v;
    },
  };
  return { db, versions };
}

const SPEC = parseAgentSpec({ name: "forge", instructions: "You are Forge. Build from merged plans." });

describe("ensureAgentFromSpec (Track 12: YAML instructions → AgentVersion)", () => {
  it("first seed publishes version 1 with the spec's instructions", async () => {
    const { db } = makeDb();
    const res = await ensureAgentFromSpec(db, "tn1", SPEC);
    expect(res.published).toBe(true);
    expect(res.agent.name).toBe("forge");
    expect(res.version.versionNumber).toBe(1);
    expect(res.version.instructions).toBe(SPEC.instructions);
  });

  it("re-seeding with unchanged instructions is a no-op reusing the latest version", async () => {
    const { db, versions } = makeDb();
    const first = await ensureAgentFromSpec(db, "tn1", SPEC);
    const again = await ensureAgentFromSpec(db, "tn1", SPEC);
    expect(again.published).toBe(false);
    expect(again.version.id).toBe(first.version.id);
    expect(versions).toHaveLength(1);
  });

  it("changed instructions publish the next version number", async () => {
    const { db, versions } = makeDb();
    await ensureAgentFromSpec(db, "tn1", SPEC);
    const updated = await ensureAgentFromSpec(db, "tn1", { ...SPEC, instructions: "v2 instructions" });
    expect(updated.published).toBe(true);
    expect(updated.version.versionNumber).toBe(2);
    expect(versions).toHaveLength(2);
  });

  it("a configured repo is TAUGHT in the published persona (enforcement without disclosure strands the agent)", async () => {
    const withRepo = parseAgentSpec({
      name: "forge",
      instructions: "You are Forge.",
      repo: "acme/service",
      plans: { branch: "design-plans" },
    });
    const { db, versions } = makeDb();
    const res = await ensureAgentFromSpec(db, "tn1", withRepo);
    expect(res.version.instructions).toContain('Pass exactly "acme/service"');
    expect(res.version.instructions).toContain("plans branch (design-plans)");
    // Idempotency holds over the COMPOSED instructions.
    const again = await ensureAgentFromSpec(db, "tn1", withRepo);
    expect(again.published).toBe(false);
    expect(versions).toHaveLength(1);
  });
});

describe("seedConfiguredAgents (Track 14: configured agents, no hardcoded defaults)", () => {
  it("seeds YAML specs (first = default) and publishes their instructions", async () => {
    const { db, versions } = makeDb();
    const other = parseAgentSpec({
      name: "quill",
      description: "doc agent",
      keywords: ["doc"],
      instructions: "Draft documents.",
    });
    const seeded = await seedConfiguredAgents(db, "tn1", { specs: [SPEC, other] });
    expect(seeded.defaultAgent).toBe("forge");
    expect(seeded.agents.map((a) => a.name)).toEqual(["forge", "quill"]);
    expect(seeded.agents[1]).toEqual({ name: "quill", description: "doc agent", keywords: ["doc"] });
    expect(Object.keys(seeded.agentIdByName)).toEqual(["forge", "quill"]);
    expect(versions).toHaveLength(2);
  });

  it("accepts bare descriptors (demo path) without publishing versions", async () => {
    const { db, versions } = makeDb();
    const seeded = await seedConfiguredAgents(db, "tn1", { agents: [{ name: "bruce" }] });
    expect(seeded.defaultAgent).toBe("bruce");
    expect(versions).toHaveLength(0);
  });

  it("throws when no agents are configured", async () => {
    const { db } = makeDb();
    await expect(seedConfiguredAgents(db, "tn1", {})).rejects.toThrow(/no agents configured/);
  });
});
