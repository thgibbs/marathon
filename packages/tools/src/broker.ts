import { redactSecrets } from "@marathon/core";
import { ToolBlockedError, type ToolCallContext, type ToolGateway } from "./gateway";
import type { ToolInput } from "./types";

/**
 * The host-side tool broker (design §12.6). A sandboxed agent cannot hold
 * credentials or run governed tools directly; it sends a request, and the host runs
 * it through the `ToolGateway` (policy → credential injection → execute → redact →
 * audit) and returns a structured, already-redacted response. Transport-agnostic:
 * a transport (socket/stdio) calls {@link handleToolRequest}; the result is safe to
 * hand back across the sandbox boundary.
 */
export interface ToolBrokerRequest {
  tool: string;
  input: ToolInput;
}

export type ToolBrokerResponse =
  | { status: "ok"; content: string }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; reason: string }
  | { status: "error"; error: string };

/** Run one brokered tool request through the gateway; never throws. */
export async function handleToolRequest(
  gateway: ToolGateway,
  ctx: ToolCallContext,
  req: ToolBrokerRequest,
): Promise<ToolBrokerResponse> {
  try {
    const res = await gateway.run(req.tool, req.input, ctx);
    // Redact before the output crosses back to the (untrusted) agent/model context (§12.2).
    return { status: "ok", content: redactSecrets(res.content) };
  } catch (err) {
    if (err instanceof ToolBlockedError) {
      return err.decision === "needs_approval"
        ? { status: "approval_required", reason: err.reason }
        : { status: "denied", reason: err.reason };
    }
    return { status: "error", error: String(err instanceof Error ? err.message : err) };
  }
}
