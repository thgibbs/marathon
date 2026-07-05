import type { AgentSpec } from "@marathon/config";
import type { Task } from "@marathon/core";
import type { Database } from "@marathon/db";
import { describe, expect, it } from "vitest";
import { BUILD_TOOL_DEFS, isBuildTask, makeBuildWiring, makeLoopStepRunner } from "../src/build";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: "forge",
    instructions: "Implement merged plans.",
    harness: "pi",
    repo: "acme/service",
    tools: [
      { tool: "github.exec", families: ["pr view", "pr create"] },
      { tool: "git.exec", families: ["push", "fetch"] },
      { tool: "delivery.report_pr" },
    ],
    sandbox: { network: "bridge" },
    plans: { branch: "marathon-plans" },
    models: { default: "openai:gpt-4o-mini" },
    budget: { limitUsd: 5 },
    ...overrides,
  };
}

// makeBuildWiring only reads these Database members at construction time.
const fakeDb = {
  getTask: async () => null,
  sumModelCostUsd: async () => 0,
  createCodeChange: async () => ({}) as never,
  getCodeChangeByTask: async () => null,
  updateCodeChangeSubmission: async () => ({}) as never,
  recordCodeChangeReport: async () => ({}) as never,
  recordToolInvocation: async () => ({}) as never,
  write: async () => ({}) as never,
} as unknown as Database;

const secrets = { get: async () => "tok" };

function wire(spec: AgentSpec) {
  return makeBuildWiring({
    db: fakeDb,
    spec,
    secrets,
    getClient: () => ({}) as never,
    source: "/tmp/never-cloned",
  });
}

describe("makeBuildWiring (Track 15 — the coherent BUILD loop from one spec)", () => {
  it("refuses to wire without the ONE configured repo", () => {
    expect(() => wire(makeSpec({ repo: undefined }))).toThrow(/configured repo/);
  });

  it("resolves the model from the spec: `build` role when routed, else default", () => {
    expect(wire(makeSpec()).modelRef).toBe("openai:gpt-4o-mini");
    expect(
      wire(makeSpec({ models: { default: "openai:gpt-4o-mini", build: "openai:gpt-4o" } })).modelRef,
    ).toBe("openai:gpt-4o");
  });

  it("registers only the granted brokered tools", async () => {
    const { gateway } = wire(makeSpec({ tools: [{ tool: "git.exec", families: ["push"] }] }));
    // Ungranted tools are absent from the gateway entirely (not just denied).
    await expect(
      gateway.run(
        "github.exec",
        { argv: ["pr", "view", "1", "--repo", "acme/service"] },
        { taskId: "t1", tenantId: "tn1" },
      ),
    ).rejects.toThrow(/unknown tool/);
  });

  it("fails the boot on a family typo in the YAML", () => {
    expect(() => wire(makeSpec({ tools: [{ tool: "github.exec", families: ["pr wiew"] }] }))).toThrow(
      /unknown gh command family/,
    );
  });

  it("has a Pi-facing definition for every BUILD tool it can register", () => {
    for (const name of ["github.exec", "git.exec", "delivery.report_pr"]) {
      expect(BUILD_TOOL_DEFS[name]?.name).toBe(name);
    }
  });
});

describe("isBuildTask / makeLoopStepRunner", () => {
  const buildTask = {
    id: "t-build",
    checkpoint: null,
    sourceRef: {
      kind: "implementation",
      planRef: { repo: "acme/service", docPath: "docs/plan.md", mergeCommitSha: "abc" },
      baseSha: "abc",
    },
  } as unknown as Task;
  const docTask = { id: "t-doc", checkpoint: null, sourceRef: { channel: "C1" } } as unknown as Task;

  it("recognizes BUILD-stage tasks by their plan binding", () => {
    expect(isBuildTask(buildTask)).toBe(true);
    expect(isBuildTask(docTask)).toBe(false);
  });

  it("routes BUILD tasks to the build runner and the rest to the agent runner", async () => {
    const calls: string[] = [];
    const db = {
      getTask: async (id: string) => (id === "t-build" ? buildTask : docTask),
    } as unknown as Database;
    const runner = makeLoopStepRunner(db, {
      build: async () => (calls.push("build"), { stepType: "noop", checkpoint: { completedSteps: [], findings: [] }, done: true }),
      agent: async () => (calls.push("agent"), { stepType: "noop", checkpoint: { completedSteps: [], findings: [] }, done: true }),
    });
    await runner({ taskId: "t-build", checkpoint: { completedSteps: [], findings: [] } });
    await runner({ taskId: "t-doc", checkpoint: { completedSteps: [], findings: [] } });
    expect(calls).toEqual(["build", "agent"]);
  });
});
