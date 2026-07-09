import type { AgentSpec } from "@marathon/config";
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
/** Tool namespaces whose grants act on a repo and so require the ONE configured repo. */
const REPO_SCOPED_TOOL_RE = /^(github|git|document|delivery|review)\./;

/**
 * The gateway policy for a YAML-configured agent (Track 14): one grant per
 * declared tool, with the spec's ONE configured repo (§0.4) applied as the
 * repo allowlist on every grant. Command families ride the spec separately —
 * they narrow the exec tools at construction (`ghFamiliesForNames`), not here.
 *
 * Granting a repo-scoped tool without `repo:` throws at wiring time: an
 * unconstrained GitHub/document grant would silently drop the one-repo
 * boundary, so the boot fails instead (set `repo:` in the agent YAML).
 */
export function toolPolicyFromSpec(spec: Pick<AgentSpec, "name" | "tools" | "repo">): ToolPolicy {
  if (!spec.repo) {
    const scoped = spec.tools.filter((t) => REPO_SCOPED_TOOL_RE.test(t.tool)).map((t) => t.tool);
    if (scoped.length > 0) {
      throw new Error(
        `agent '${spec.name}': repo-scoped tools granted without a configured repo (${scoped.join(", ")}) — ` +
          `set 'repo: owner/repo' in the agent YAML (§0.4: the ONE configured repo scopes every grant)`,
      );
    }
  }
  return {
    grants: spec.tools.map((t) => ({
      tool: t.tool,
      ...(spec.repo ? { constraints: { allowedRepos: [spec.repo] } } : {}),
    })),
  };
}

export function enforce(policy: ToolPolicy, tool: Tool, input: ToolInput): PolicyResult {
  const grant = findGrant(policy, tool.name);
  if (!grant) return { decision: "deny", reason: `tool not granted: ${tool.name}` };

  const allowedRepos = grant.constraints?.allowedRepos;
  if (allowedRepos && typeof input.repo === "string" && !allowedRepos.includes(input.repo)) {
    // Name what IS allowed: the error is agent-visible, and a model that
    // guessed the repo can only self-correct if the block teaches it.
    return {
      decision: "deny",
      reason: `repo not allowed: ${input.repo} — this agent's configured repo is ${allowedRepos.join(", ")}`,
    };
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
