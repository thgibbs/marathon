import type { AgentSpec } from "@marathon/config";
import { Database } from "@marathon/db";
import type { AgentDescriptor } from "@marathon/surface";
import { seedConfiguredAgents } from "@marathon/worker";

export interface GithubBootstrapResult {
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent: string;
}

/**
 * Ensure a tenant (for the GitHub owner) and the configured agents exist.
 *
 * Agents come from configuration (Track 14), not hardcoded defaults: pass
 * `specs` (YAML agent definitions, e.g. `loadAgentSpecs(cfg.agentsDir)`) to
 * seed each agent's instructions through an AgentVersion, or bare `agents`
 * descriptors for tests/demos that manage personas themselves. The first
 * configured agent is the default.
 */
export async function bootstrapGithubApp(
  db: Database,
  opts: { owner: string; specs?: AgentSpec[]; agents?: AgentDescriptor[] },
): Promise<GithubBootstrapResult> {
  const tenant = await db.findOrCreateTenantByGithubOwner(opts.owner);
  const seeded = await seedConfiguredAgents(db, tenant.id, opts);
  return { tenantId: tenant.id, ...seeded };
}
