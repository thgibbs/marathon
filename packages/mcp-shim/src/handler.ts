import { type BrokerToolSpec, brokerResponseText, type ToolBrokerResponse } from "@marathon/tools";

/**
 * The MCP↔broker bridge (design §12.6; claude-code-impl.md §3.1).
 *
 * `marathon-mcp-shim` is spawned by the Claude Code CLI as a stdio MCP server. It
 * carries ZERO configuration and ZERO secrets: it forwards `tools/list` and
 * `tools/call` to `serveToolBroker` over a per-task unix socket, and the host resolves
 * everything (tool set, credentials, policy, redaction, audit) per task. This module is
 * the pure request→response mapping, so it can be tested against a fake broker with no
 * process/socket/CLI involved.
 */

/** The subset of {@link ToolBrokerClient} the shim needs (kept minimal for fakes). */
export interface BrokerLike {
  listTools(): Promise<BrokerToolSpec[]>;
  request(req: { tool: string; input: Record<string, unknown> }): Promise<ToolBrokerResponse>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "marathon", version: "0.1.0" };

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Handle one MCP JSON-RPC request. Returns the response object, or `null` for a
 * notification (no `id`) that needs no reply. `initialize`/`ping` are answered
 * locally; `tools/list` and `tools/call` are forwarded to the broker.
 */
export async function handleMcpRequest(broker: BrokerLike, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(msg.id, {});
    case "tools/list": {
      const tools = await broker.listTools();
      return ok(msg.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters ?? { type: "object", properties: {} },
        })),
      });
    }
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      if (!name) return err(msg.id, -32602, "tools/call requires a tool name");
      const resp = await broker.request({ tool: name, input: args });
      // Broker refusals (denied / requires_proposal) come back as tool-result TEXT
      // so the model reads the typed refusal and can react — mirrors the Pi path.
      // A transport/tool error surfaces as an MCP tool error (isError).
      return ok(msg.id, {
        content: [{ type: "text", text: brokerResponseText(resp) }],
        isError: resp.status === "error",
      });
    }
    default:
      // Unknown notifications are swallowed; unknown requests get a method-not-found error.
      return isNotification ? null : err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
