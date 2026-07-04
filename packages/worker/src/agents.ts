import type { AgentSpec } from "@marathon/config";
import type { Agent, AgentVersion, Id } from "@marathon/core";
import type { AgentDescriptor } from "@marathon/surface";

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

export interface SeededAgents {
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  /** The first configured agent — the deployment default (§7.3). */
  defaultAgent: string;
}

export interface SeedAgentsDb extends AgentSeedDb {
  findOrCreateAgent(tenantId: Id, name: string): Promise<Agent>;
}

/**
 * Seed a tenant's configured agents (Track 14): `specs` are YAML agent
 * definitions (e.g. `loadAgentSpecs(cfg.agentsDir)`) whose instructions
 * publish through an AgentVersion; bare `agents` descriptors are for
 * tests/demos that manage personas themselves. No hardcoded defaults — at
 * least one agent must be configured.
 */
export async function seedConfiguredAgents(
  db: SeedAgentsDb,
  tenantId: Id,
  opts: { specs?: AgentSpec[]; agents?: AgentDescriptor[] },
): Promise<SeededAgents> {
  const agentIdByName: Record<string, string> = {};
  const agents: AgentDescriptor[] = [];
  for (const spec of opts.specs ?? []) {
    const { agent } = await ensureAgentFromSpec(db, tenantId, spec);
    agentIdByName[spec.name] = agent.id;
    agents.push({ name: spec.name, description: spec.description, keywords: spec.keywords });
  }
  for (const a of opts.agents ?? []) {
    if (agentIdByName[a.name]) continue;
    const agent = await db.findOrCreateAgent(tenantId, a.name);
    agentIdByName[a.name] = agent.id;
    agents.push(a);
  }
  const defaultAgent = agents[0]?.name;
  if (!defaultAgent) {
    throw new Error(
      "no agents configured — pass YAML agent specs (see agents/forge.yaml and MARATHON_AGENTS_DIR) or explicit agent descriptors",
    );
  }
  return { agents, agentIdByName, defaultAgent };
}
