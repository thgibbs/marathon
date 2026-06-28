import { Database } from "@marathon/db";
import type { AgentDescriptor } from "@marathon/surface";

export interface BootstrapResult {
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent: string;
}

/** Ensure a tenant (for the Slack team) and the configured agents exist. */
export async function bootstrapSlackApp(
  db: Database,
  opts: { teamId: string; teamName?: string; agents?: AgentDescriptor[] },
): Promise<BootstrapResult> {
  const tenant = await db.findOrCreateTenantBySlackTeam(opts.teamId, opts.teamName ?? opts.teamId);
  const agents: AgentDescriptor[] = opts.agents ?? [
    { name: "bruce", keywords: ["error", "deploy", "incident", "checkout", "bug"] },
  ];
  const agentIdByName: Record<string, string> = {};
  for (const a of agents) {
    const agent = await db.findOrCreateAgent(tenant.id, a.name);
    agentIdByName[a.name] = agent.id;
  }
  return {
    tenantId: tenant.id,
    agents,
    agentIdByName,
    defaultAgent: agents[0]?.name ?? "bruce",
  };
}
