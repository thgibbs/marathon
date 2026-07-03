import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { handleToolRequest } from "../src/broker";
import { ToolGateway, ToolRegistry } from "../src/gateway";
import type { Tool, ToolPolicy } from "../src/types";

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;

const readTool: Tool = {
  name: "doc.read",
  description: "",
  riskAxes: AXES,
  defaultMode: "autonomous",
  async execute() {
    return { content: "file contents (secret ghp_SENTINEL0000000000000000000000000000)" };
  },
};
const deleteTool: Tool = {
  name: "doc.delete",
  description: "",
  riskAxes: { ...AXES, reversible: false },
  defaultMode: "proposed_effect",
  async execute() {
    return { content: "deleted" };
  },
};
const boomTool: Tool = {
  name: "boom",
  description: "",
  riskAxes: AXES,
  defaultMode: "autonomous",
  async execute() {
    throw new Error("kaboom");
  },
};

const ctx = { taskId: "t1", tenantId: "tn1" };
const policy: ToolPolicy = { grants: [{ tool: "doc.read" }, { tool: "doc.delete" }, { tool: "boom" }] };
const gateway = new ToolGateway({
  registry: new ToolRegistry([readTool, deleteTool, boomTool]),
  policy,
  secrets: new EnvSecretStore({}),
});

describe("handleToolRequest (tool broker)", () => {
  it("returns ok with redacted content for an allowed tool", async () => {
    const r = await handleToolRequest(gateway, ctx, { tool: "doc.read", input: {} });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.content).not.toContain("ghp_SENTINEL"); // gateway redacts
  });

  it("returns requires_proposal for a proposed_effect tool (no throw)", async () => {
    const r = await handleToolRequest(gateway, ctx, { tool: "doc.delete", input: {} });
    expect(r.status).toBe("requires_proposal");
  });

  it("returns denied for an ungranted tool", async () => {
    const gw = new ToolGateway({ registry: new ToolRegistry([readTool]), policy: { grants: [] }, secrets: new EnvSecretStore({}) });
    const r = await handleToolRequest(gw, ctx, { tool: "doc.read", input: {} });
    expect(r.status).toBe("denied");
  });

  it("captures execution errors as a response (never throws across the boundary)", async () => {
    const r = await handleToolRequest(gateway, ctx, { tool: "boom", input: {} });
    expect(r).toEqual({ status: "error", error: "kaboom" });
  });
});
