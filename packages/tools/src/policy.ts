import type { Tool, ToolGrant, ToolInput, ToolPolicy } from "./types";

export type PolicyDecision = "allow" | "deny" | "needs_approval";

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
}

export function findGrant(policy: ToolPolicy, toolName: string): ToolGrant | undefined {
  return policy.grants.find((g) => g.tool === toolName);
}

/**
 * The embedded-permissioning decision (design.md §7.8). Gating is on
 * *destructiveness*, not read-vs-write:
 *   - ungranted tool            -> deny
 *   - constraint violation       -> deny (e.g. repo not in allowlist)
 *   - destructive (granted)      -> needs_approval (handled in M5)
 *   - otherwise                  -> allow
 */
export function enforce(policy: ToolPolicy, tool: Tool, input: ToolInput): PolicyResult {
  const grant = findGrant(policy, tool.name);
  if (!grant) return { decision: "deny", reason: `tool not granted: ${tool.name}` };

  const allowedRepos = grant.constraints?.allowedRepos;
  if (allowedRepos && typeof input.repo === "string" && !allowedRepos.includes(input.repo)) {
    return { decision: "deny", reason: `repo not allowed: ${input.repo}` };
  }

  if (tool.destructive) {
    return { decision: "needs_approval", reason: "destructive action requires approval" };
  }

  return { decision: "allow" };
}
