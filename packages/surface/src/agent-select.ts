import type { AgentDescriptor, NormalizedInvocation } from "./types";

/**
 * Resolve which agent handles an invocation (design.md §7.3 default-agent
 * selection): an explicitly named agent wins; otherwise pick the best
 * keyword match, falling back to a configured default (or the first agent).
 */
export function selectAgent(
  invocation: Pick<NormalizedInvocation, "agentName" | "text">,
  agents: AgentDescriptor[],
  defaultName?: string,
): AgentDescriptor | undefined {
  if (invocation.agentName) {
    return agents.find((a) => a.name === invocation.agentName);
  }
  const text = invocation.text.toLowerCase();
  const scored = agents
    .map((a) => ({ a, score: (a.keywords ?? []).filter((k) => text.includes(k.toLowerCase())).length }))
    .sort((x, y) => y.score - x.score);
  if (scored[0] && scored[0].score > 0) return scored[0].a;
  return agents.find((a) => a.name === defaultName) ?? agents[0];
}
