import { EnvSecretStore } from "@marathon/config";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { sanitizeToolName } from "../src/broker";
import { ToolBrokerClient, serveToolBroker } from "../src/broker-transport";
import { ToolGateway, ToolRegistry } from "../src/gateway";
import type { Tool, ToolPolicy } from "../src/types";

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;
const readTool: Tool = {
  name: "github.read_file",
  description: "read a file",
  riskAxes: AXES,
  defaultMode: "autonomous",
  async execute() {
    return { content: "file contents" };
  },
};

const SPECS = [{ name: "github.read_file", description: "read a file", parameters: { type: "object" } }];

function wired(opts: { onAskUser?: (q: string) => void } = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const gateway = new ToolGateway({
    registry: new ToolRegistry([readTool]),
    policy: { grants: [{ tool: "github.read_file" }] } as ToolPolicy,
    secrets: new EnvSecretStore({}),
  });
  serveToolBroker(toServer, toClient, gateway, { taskId: "t1", tenantId: "tn1" }, { tools: SPECS, onAskUser: opts.onAskUser });
  const client = new ToolBrokerClient(toClient, toServer);
  return { client, cleanup: () => { toServer.destroy(); toClient.destroy(); } };
}

describe("broker list_tools + sanitized-name mapping (K7 §3.1)", () => {
  it("sanitizeToolName strips dots for the model-facing name", () => {
    expect(sanitizeToolName("github.read_file")).toBe("github_read_file");
  });

  it("list_tools advertises sanitized names", async () => {
    const { client, cleanup } = wired();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["github_read_file"]);
    cleanup();
  });

  it("advertises ask_user only when a clarification sink is set", async () => {
    const withAsk = wired({ onAskUser: () => {} });
    expect((await withAsk.client.listTools()).map((t) => t.name)).toContain("ask_user");
    withAsk.cleanup();
    const without = wired();
    expect((await without.client.listTools()).map((t) => t.name)).not.toContain("ask_user");
    without.cleanup();
  });

  it("maps a sanitized tool call back to the real gateway tool", async () => {
    const { client, cleanup } = wired();
    const r = await client.request({ tool: "github_read_file", input: {} });
    expect(r).toEqual({ status: "ok", content: "file contents" });
    cleanup();
  });

  it("captures ask_user without touching the gateway", async () => {
    let captured: string | undefined;
    const { client, cleanup } = wired({ onAskUser: (q) => (captured = q) });
    const r = await client.request({ tool: "ask_user", input: { question: "Which env?" } });
    expect(r.status).toBe("ok");
    expect(captured).toBe("Which env?");
    cleanup();
  });
});
