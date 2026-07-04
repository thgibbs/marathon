import { describe, expect, it } from "vitest";
import { enforce, toolPolicyFromSpec } from "../src/policy";
import type { Tool, ToolPolicy } from "../src/types";

const readTool: Tool = {
  name: "github.read_file",
  description: "",
  riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
  defaultMode: "autonomous",
  async execute() {
    return { content: "" };
  },
};
const nativeReviewTool: Tool = {
  ...readTool,
  name: "document.create",
  riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
  defaultMode: "native_review",
};
const highRiskTool: Tool = {
  ...readTool,
  name: "deploy.rollback",
  riskAxes: { reversible: false, crossesTrustBoundary: false, audience: "tenant", costly: false },
  defaultMode: "proposed_effect",
};
const disabledTool: Tool = { ...readTool, name: "email.send", defaultMode: "disabled" };

describe("enforce", () => {
  it("denies ungranted tools", () => {
    const policy: ToolPolicy = { grants: [] };
    expect(enforce(policy, readTool, {})).toEqual({
      decision: "deny",
      reason: "tool not granted: github.read_file",
    });
  });

  it("allows a granted autonomous tool", () => {
    const policy: ToolPolicy = { grants: [{ tool: "github.read_file" }] };
    expect(enforce(policy, readTool, {}).decision).toBe("allow");
  });

  it("allows a granted native-review tool (review happens in the artifact's surface)", () => {
    const policy: ToolPolicy = { grants: [{ tool: "document.create" }] };
    expect(enforce(policy, nativeReviewTool, {}).decision).toBe("allow");
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

  it("routes proposed_effect tools to requires_proposal (even when granted)", () => {
    const policy: ToolPolicy = { grants: [{ tool: "deploy.rollback" }] };
    expect(enforce(policy, highRiskTool, {}).decision).toBe("requires_proposal");
  });

  it("denies disabled tools (even when granted)", () => {
    const policy: ToolPolicy = { grants: [{ tool: "email.send" }] };
    expect(enforce(policy, disabledTool, {})).toEqual({
      decision: "deny",
      reason: "tool is disabled: email.send",
    });
  });
});

describe("toolPolicyFromSpec (Track 14: grants from the agent YAML)", () => {
  it("applies the ONE configured repo as every grant's allowlist", () => {
    const policy = toolPolicyFromSpec({
      name: "forge",
      repo: "acme/service",
      tools: [{ tool: "github.read_file" }, { tool: "document.create" }],
    });
    expect(policy.grants).toEqual([
      { tool: "github.read_file", constraints: { allowedRepos: ["acme/service"] } },
      { tool: "document.create", constraints: { allowedRepos: ["acme/service"] } },
    ]);
  });

  it("fails the boot when repo-scoped tools are granted without a repo", () => {
    expect(() =>
      toolPolicyFromSpec({ name: "forge", tools: [{ tool: "github.read_file" }, { tool: "git.exec" }] }),
    ).toThrow(/repo-scoped tools granted without a configured repo \(github\.read_file, git\.exec\)/);
  });

  it("allows non-repo tools without a repo", () => {
    const policy = toolPolicyFromSpec({ name: "grace", tools: [{ tool: "sql.query" }] });
    expect(policy.grants).toEqual([{ tool: "sql.query" }]);
  });
});
