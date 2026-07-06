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
  | { status: "requires_proposal"; reason: string }
  | { status: "error"; error: string };

/**
 * A governed tool as advertised across the broker boundary (the MCP shim's
 * `tools/list`). Carries no credentials — name, description, and JSON-schema
 * parameters only, resolved host-side per task.
 */
export interface BrokerToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Model-facing tool names must match `^[A-Za-z0-9_-]+$` (no dots): Marathon
 * tool names like `github.read_file` are sanitized to `github_read_file` for
 * the model, and mapped back to the real name host-side before the gateway
 * runs (mirrors the Pi custom-tool path, `pi.ts`). The mapping lives on the
 * host so the sandboxed shim stays zero-config.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Render a broker response as the text handed back to the model (typed-refusal preserving). */
export function brokerResponseText(resp: ToolBrokerResponse): string {
  switch (resp.status) {
    case "ok":
      return resp.content;
    case "denied":
      return `[blocked] ${resp.reason}`;
    case "requires_proposal":
      return `[requires proposal] ${resp.reason}`;
    case "error":
      return `[error] ${resp.error}`;
  }
}

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
      return err.decision === "requires_proposal"
        ? { status: "requires_proposal", reason: err.reason }
        : { status: "denied", reason: err.reason };
    }
    return { status: "error", error: String(err instanceof Error ? err.message : err) };
  }
}
