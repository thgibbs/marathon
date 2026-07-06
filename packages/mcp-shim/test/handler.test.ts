import type { BrokerToolSpec, ToolBrokerResponse } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import { type BrokerLike, handleMcpRequest, MCP_PROTOCOL_VERSION } from "../src/handler";

function fakeBroker(overrides: Partial<BrokerLike> = {}): { broker: BrokerLike; calls: { tool: string; input: unknown }[] } {
  const calls: { tool: string; input: unknown }[] = [];
  const tools: BrokerToolSpec[] = [{ name: "github_read_file", description: "read", parameters: { type: "object" } }];
  const broker: BrokerLike = {
    listTools: overrides.listTools ?? (async () => tools),
    request:
      overrides.request ??
      (async (req) => {
        calls.push(req);
        return { status: "ok", content: "brokered result" } satisfies ToolBrokerResponse;
      }),
  };
  return { broker, calls };
}

describe("marathon-mcp-shim handler (MCP ↔ broker, K7 §3.1)", () => {
  it("answers initialize locally with protocol + tools capability", async () => {
    const { broker } = fakeBroker();
    const r = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } });
  });

  it("returns null (no reply) for the initialized notification", async () => {
    const { broker } = fakeBroker();
    expect(await handleMcpRequest(broker, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("tools/list projects broker specs into MCP inputSchema", async () => {
    const { broker } = fakeBroker();
    const r = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r?.result).toEqual({
      tools: [{ name: "github_read_file", description: "read", inputSchema: { type: "object" } }],
    });
  });

  it("tools/call forwards to the broker and wraps the ok result as text content", async () => {
    const { broker, calls } = fakeBroker();
    const r = await handleMcpRequest(broker, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "github_read_file", arguments: { path: "a.ts" } },
    });
    expect(calls).toEqual([{ tool: "github_read_file", input: { path: "a.ts" } }]);
    expect(r?.result).toEqual({ content: [{ type: "text", text: "brokered result" }], isError: false });
  });

  it("preserves a typed refusal (requires_proposal) as tool text, not an MCP error", async () => {
    const { broker } = fakeBroker({ request: async () => ({ status: "requires_proposal", reason: "needs review" }) });
    const r = await handleMcpRequest(broker, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "x", arguments: {} },
    });
    expect(r?.result).toEqual({ content: [{ type: "text", text: "[requires proposal] needs review" }], isError: false });
  });

  it("marks a transport/tool error result with isError", async () => {
    const { broker } = fakeBroker({ request: async () => ({ status: "error", error: "boom" }) });
    const r = await handleMcpRequest(broker, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "x", arguments: {} },
    });
    expect(r?.result).toMatchObject({ isError: true });
  });

  it("method-not-found for an unknown request", async () => {
    const { broker } = fakeBroker();
    const r = await handleMcpRequest(broker, { jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(r?.error?.code).toBe(-32601);
  });
});
