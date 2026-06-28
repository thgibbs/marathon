import { EnvSecretStore } from "@marathon/config";
import { ToolGateway, ToolRegistry, type Tool, type ToolPolicy } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import { runGovernedTool } from "../src/governed";

const readTool: Tool = {
  name: "github.read_file",
  description: "",
  riskLevel: "low",
  destructive: false,
  async execute() {
    return { content: "file contents" };
  },
};
const mergeTool: Tool = {
  name: "github.merge_pull_request",
  description: "",
  riskLevel: "high",
  destructive: true,
  async execute() {
    return { content: "merged" };
  },
};

const ctx = { taskId: "t1", tenantId: "tn1" };
const policy: ToolPolicy = { grants: [{ tool: "github.read_file" }, { tool: "github.merge_pull_request" }] };
const gateway = new ToolGateway({
  registry: new ToolRegistry([readTool, mergeTool]),
  policy,
  secrets: new EnvSecretStore({}),
});

describe("runGovernedTool", () => {
  it("executes an allowed tool", async () => {
    const o = await runGovernedTool(gateway, "github.read_file", {}, ctx);
    expect(o).toEqual({ status: "ok", content: "file contents" });
  });

  it("returns approval_required for a destructive tool", async () => {
    const o = await runGovernedTool(gateway, "github.merge_pull_request", { number: 1 }, ctx);
    expect(o.status).toBe("approval_required");
  });

  it("returns denied for an ungranted tool", async () => {
    const gw = new ToolGateway({
      registry: new ToolRegistry([readTool]),
      policy: { grants: [] },
      secrets: new EnvSecretStore({}),
    });
    const o = await runGovernedTool(gw, "github.read_file", {}, ctx);
    expect(o.status).toBe("denied");
  });
});
