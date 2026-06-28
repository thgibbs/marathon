import { ToolBlockedError, type ToolCallContext, type ToolGateway, type ToolInput } from "@marathon/tools";

export type GovernedOutcome =
  | { status: "ok"; content: string }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; reason: string };

/**
 * Run a tool through the Tool Gateway from inside an agent loop. The gateway is
 * the embedded permissioning chokepoint (policy, credential injection, audit,
 * redaction); this maps a blocked call to a structured outcome the agent/model
 * can act on (rather than an exception).
 */
export async function runGovernedTool(
  gateway: ToolGateway,
  toolName: string,
  input: ToolInput,
  ctx: ToolCallContext,
): Promise<GovernedOutcome> {
  try {
    const res = await gateway.run(toolName, input, ctx);
    return { status: "ok", content: res.content };
  } catch (err) {
    if (err instanceof ToolBlockedError) {
      return err.decision === "needs_approval"
        ? { status: "approval_required", reason: err.reason }
        : { status: "denied", reason: err.reason };
    }
    throw err;
  }
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
