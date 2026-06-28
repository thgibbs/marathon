import { describe, expect, it } from "vitest";
import { enforce } from "../src/policy";
import type { Tool, ToolPolicy } from "../src/types";

const readTool: Tool = {
  name: "github.read_file",
  description: "",
  riskLevel: "low",
  destructive: false,
  async execute() {
    return { content: "" };
  },
};
const destructiveTool: Tool = { ...readTool, name: "deploy.rollback", riskLevel: "high", destructive: true };

describe("enforce", () => {
  it("denies ungranted tools", () => {
    const policy: ToolPolicy = { grants: [] };
    expect(enforce(policy, readTool, {})).toEqual({
      decision: "deny",
      reason: "tool not granted: github.read_file",
    });
  });

  it("allows a granted non-destructive tool", () => {
    const policy: ToolPolicy = { grants: [{ tool: "github.read_file" }] };
    expect(enforce(policy, readTool, {}).decision).toBe("allow");
  });

  it("enforces repo allowlist constraints", () => {
    const policy: ToolPolicy = {
      grants: [{ tool: "github.read_file", constraints: { allowedRepos: ["o/ok"] } }],
    };
    expect(enforce(policy, readTool, { repo: "o/ok" }).decision).toBe("allow");
    expect(enforce(policy, readTool, { repo: "o/nope" })).toEqual({
      decision: "deny",
      reason: "repo not allowed: o/nope",
    });
  });

  it("requires approval for destructive tools (even when granted)", () => {
    const policy: ToolPolicy = { grants: [{ tool: "deploy.rollback" }] };
    expect(enforce(policy, destructiveTool, {}).decision).toBe("needs_approval");
  });
});
