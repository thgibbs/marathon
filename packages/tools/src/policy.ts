import type { Tool, ToolGrant, ToolInput, ToolPolicy } from "./types";

export type PolicyDecision = "allow" | "deny" | "requires_proposal";

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
}

export function findGrant(policy: ToolPolicy, toolName: string): ToolGrant | undefined {
  return policy.grants.find((g) => g.tool === toolName);
}

/**
 * The embedded-permissioning decision (design §7.8). Gating follows the tool's
 * declared default mode, not a destructive flag:
 *   - ungranted tool         -> deny
 *   - constraint violation    -> deny (e.g. repo not in allowlist)
 *   - disabled                -> deny
 *   - proposed_effect         -> requires_proposal (high-risk effects are never
 *                                direct tools — the model proposes, a non-model
 *                                executor performs; §7.9)
 *   - autonomous / native_review -> allow (native review happens in the
 *                                artifact's own surface, e.g. PR merge)
 */
export function enforce(policy: ToolPolicy, tool: Tool, input: ToolInput): PolicyResult {
  const grant = findGrant(policy, tool.name);
  if (!grant) return { decision: "deny", reason: `tool not granted: ${tool.name}` };

  const allowedRepos = grant.constraints?.allowedRepos;
  if (allowedRepos && typeof input.repo === "string" && !allowedRepos.includes(input.repo)) {
    return { decision: "deny", reason: `repo not allowed: ${input.repo}` };
  }

  switch (tool.defaultMode) {
    case "disabled":
      return { decision: "deny", reason: `tool is disabled: ${tool.name}` };
    case "proposed_effect":
      return {
        decision: "requires_proposal",
        reason: `${tool.name} is a high-risk effect — it cannot run as a direct tool call; propose it for review instead (§7.9)`,
      };
    default:
      return { decision: "allow" };
  }
}
