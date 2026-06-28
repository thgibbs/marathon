import { Database } from "@marathon/db";
import type { AgentDescriptor } from "@marathon/surface";

export interface GithubBootstrapResult {
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent: string;
}

/** Ensure a tenant (for the GitHub owner) and the configured agents exist. */
export async function bootstrapGithubApp(
  db: Database,
  opts: { owner: string; agents?: AgentDescriptor[] },
): Promise<GithubBootstrapResult> {
  const tenant = await db.findOrCreateTenantByGithubOwner(opts.owner);
  const agents: AgentDescriptor[] = opts.agents ?? [
    { name: "quill", keywords: ["doc", "design", "plan", "draft", "spec"] },
  ];
  const agentIdByName: Record<string, string> = {};
  for (const a of agents) {
    const agent = await db.findOrCreateAgent(tenant.id, a.name);
    agentIdByName[a.name] = agent.id;
  }
  return { tenantId: tenant.id, agents, agentIdByName, defaultAgent: agents[0]?.name ?? "quill" };
}
