import type { AgentSpec } from "@marathon/config";
import type { Agent, AgentVersion, Id } from "@marathon/core";

/**
 * Seed an agent from a YAML spec (Track 12; design §21 Forge): the spec's
 * instructions flow through an `AgentVersion` row — the same path
 * `buildAgentPrompt` already loads personas from — so a YAML-defined agent is
 * indistinguishable from one authored any other way. Idempotent: re-seeding
 * with unchanged instructions reuses the latest version; changed instructions
 * publish the next version number.
 */
export interface AgentSeedDb {
  findOrCreateAgent(tenantId: Id, name: string): Promise<Agent>;
  getLatestAgentVersion(agentId: Id): Promise<AgentVersion | null>;
  createAgentVersion(input: {
    agentId: Id;
    versionNumber: number;
    instructions?: string;
  }): Promise<AgentVersion>;
}

export interface EnsureAgentResult {
  agent: Agent;
  version: AgentVersion;
  /** True when a new AgentVersion was published (instructions changed or first seed). */
  published: boolean;
}

export async function ensureAgentFromSpec(
  db: AgentSeedDb,
  tenantId: Id,
  spec: AgentSpec,
): Promise<EnsureAgentResult> {
  const agent = await db.findOrCreateAgent(tenantId, spec.name);
  const latest = await db.getLatestAgentVersion(agent.id);
  if (latest && latest.instructions === spec.instructions) {
    return { agent, version: latest, published: false };
  }
  const version = await db.createAgentVersion({
    agentId: agent.id,
    versionNumber: (latest?.versionNumber ?? 0) + 1,
    instructions: spec.instructions,
  });
  return { agent, version, published: true };
}
