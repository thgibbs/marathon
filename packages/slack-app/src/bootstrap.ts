import type { AgentSpec } from "@marathon/config";
import { Database } from "@marathon/db";
import type { AgentDescriptor } from "@marathon/surface";
import { seedConfiguredAgents } from "@marathon/worker";

export interface BootstrapResult {
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent: string;
}

/**
 * Ensure a tenant (for the Slack team) and the configured agents exist.
 *
 * Agents come from configuration (Track 14), not hardcoded defaults: pass
 * `specs` (YAML agent definitions, e.g. `loadAgentSpecs(cfg.agentsDir)`) to
 * seed each agent's instructions through an AgentVersion, or bare `agents`
 * descriptors for tests/demos that manage personas themselves. The first
 * configured agent is the default.
 */
export async function bootstrapSlackApp(
  db: Database,
  opts: { teamId: string; teamName?: string; tenantName?: string; specs?: AgentSpec[]; agents?: AgentDescriptor[] },
): Promise<BootstrapResult> {
  // §2b #14: `tenantName` (MARATHON_TENANT) makes this surface bind to the
  // shared deployment tenant instead of keying a tenant of its own.
  const tenant = await db.findOrCreateTenantBySurface({
    surface: "slack",
    externalId: opts.teamId,
    name: opts.tenantName ?? opts.teamName ?? opts.teamId,
    deployment: opts.tenantName,
  });
  const seeded = await seedConfiguredAgents(db, tenant.id, opts);
  return { tenantId: tenant.id, ...seeded };
}
