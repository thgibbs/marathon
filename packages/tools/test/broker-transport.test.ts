import { EnvSecretStore } from "@marathon/config";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ToolBrokerClient, serveToolBroker } from "../src/broker-transport";
import { ToolGateway, ToolRegistry } from "../src/gateway";
import type { Tool, ToolPolicy } from "../src/types";

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;
const readTool: Tool = { name: "doc.read", description: "", riskAxes: AXES, defaultMode: "autonomous", async execute() { return { content: "hello from host" }; } };
const deleteTool: Tool = { name: "doc.delete", description: "", riskAxes: { ...AXES, reversible: false }, defaultMode: "proposed_effect", async execute() { return { content: "deleted" }; } };

function wired(authToken?: string) {
  // two pipes: client->server and server->client
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const gateway = new ToolGateway({
    registry: new ToolRegistry([readTool, deleteTool]),
    policy: { grants: [{ tool: "doc.read" }, { tool: "doc.delete" }] } as ToolPolicy,
    secrets: new EnvSecretStore({}),
  });
  serveToolBroker(toServer, toClient, gateway, { taskId: "t1", tenantId: "tn1" }, { authToken });
  const client = new ToolBrokerClient(toClient, toServer);
  return { toServer, client, cleanup: () => { toServer.destroy(); toClient.destroy(); } };
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

describe("broker capability handshake (§3.1)", () => {
  it("serves after the correct token is presented first", async () => {
    const { toServer, client, cleanup } = wired("s3cret-token");
    toServer.write(`${JSON.stringify({ auth: "s3cret-token" })}\n`);
    const r = await client.request({ tool: "doc.read", input: {} });
    expect(r).toEqual({ status: "ok", content: "hello from host" });
    cleanup();
  });

  it("closes the connection and serves nothing when the token is wrong", async () => {
    const { toServer, client, cleanup } = wired("right-token");
    toServer.write(`${JSON.stringify({ auth: "WRONG" })}\n`);
    // The server destroys its output stream; a subsequent request never resolves.
    const raced = await Promise.race([
      client.request({ tool: "doc.read", input: {} }).then(() => "served"),
      new Promise((r) => setTimeout(() => r("no-response"), 60)),
    ]);
    expect(raced).toBe("no-response");
    cleanup();
  });

  it("does not serve a tool call sent before the token", async () => {
    const { client, cleanup } = wired("tok");
    const raced = await Promise.race([
      client.request({ tool: "doc.read", input: {} }).then(() => "served"),
      new Promise((r) => setTimeout(() => r("no-response"), 60)),
    ]);
    expect(raced).toBe("no-response");
    cleanup();
  });
});
