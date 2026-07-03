import { EnvSecretStore } from "@marathon/config";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ToolBrokerClient, serveToolBroker } from "../src/broker-transport";
import { ToolGateway, ToolRegistry } from "../src/gateway";
import type { Tool, ToolPolicy } from "../src/types";

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;
const readTool: Tool = { name: "doc.read", description: "", riskAxes: AXES, defaultMode: "autonomous", async execute() { return { content: "hello from host" }; } };
const deleteTool: Tool = { name: "doc.delete", description: "", riskAxes: { ...AXES, reversible: false }, defaultMode: "proposed_effect", async execute() { return { content: "deleted" }; } };

function wired() {
  // two pipes: client->server and server->client
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const gateway = new ToolGateway({
    registry: new ToolRegistry([readTool, deleteTool]),
    policy: { grants: [{ tool: "doc.read" }, { tool: "doc.delete" }] } as ToolPolicy,
    secrets: new EnvSecretStore({}),
  });
  serveToolBroker(toServer, toClient, gateway, { taskId: "t1", tenantId: "tn1" });
  const client = new ToolBrokerClient(toClient, toServer);
  return { client, cleanup: () => { toServer.destroy(); toClient.destroy(); } };
}

describe("broker transport (client <-> host over a stream)", () => {
  it("round-trips an allowed tool request", async () => {
    const { client, cleanup } = wired();
    const r = await client.request({ tool: "doc.read", input: {} });
    expect(r).toEqual({ status: "ok", content: "hello from host" });
    cleanup();
  });

  it("relays a proposed_effect tool as requires_proposal (creds/policy stay host-side)", async () => {
    const { client, cleanup } = wired();
    const r = await client.request({ tool: "doc.delete", input: {} });
    expect(r.status).toBe("requires_proposal");
    cleanup();
  });

  it("correlates concurrent requests by id", async () => {
    const { client, cleanup } = wired();
    const [a, b] = await Promise.all([
      client.request({ tool: "doc.read", input: {} }),
      client.request({ tool: "doc.delete", input: {} }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("requires_proposal");
    cleanup();
  });
});
