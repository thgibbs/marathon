import { handleToolRequest, type ToolCallContext, type ToolGateway, type ToolInput } from "@marathon/tools";

export type GovernedOutcome =
  | { status: "ok"; content: string }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; reason: string };

/**
 * Run a tool through the Tool Gateway from inside an agent loop, mapping a blocked
 * call to a structured outcome (rather than an exception). Thin wrapper over the
 * host-side broker (§12.6); rethrows on unexpected (non-policy) errors.
 */
export async function runGovernedTool(
  gateway: ToolGateway,
  toolName: string,
  input: ToolInput,
  ctx: ToolCallContext,
): Promise<GovernedOutcome> {
  const res = await handleToolRequest(gateway, ctx, { tool: toolName, input });
  if (res.status === "error") throw new Error(res.error);
  return res;
}

/** Render a governed outcome as text to hand back to the model. */
export function governedOutcomeText(outcome: GovernedOutcome): string {
  switch (outcome.status) {
    case "ok":
      return outcome.content;
    case "denied":
      return `[blocked] ${outcome.reason}`;
    case "approval_required":
      return `[approval required] ${outcome.reason} — a human must approve before this runs.`;
  }
}
