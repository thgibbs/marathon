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
    chat: { groundOnRepo: false, groundRef: "pinned", trustedDeployment: false },
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

  it("refuses to wire when 'on' excludes 'build' (codex-impl.md §A.3/§A.4)", () => {
    expect(() => wire(makeSpec({ on: ["draft", "design-review", "code-review"] }))).toThrow(
      /'on' does not include 'build'/,
    );
    expect(() => wire(makeSpec({ on: ["build"] }))).not.toThrow();
    expect(() => wire(makeSpec())).not.toThrow(); // omitted 'on' — every event, unchanged behavior
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

  describe("claude-code harness wiring (K7 fail-closed)", () => {
    const claudeSpec = (o: Partial<AgentSpec> = {}) =>
      makeSpec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6" }, ...o });

    it("wires with a proxy (opt-in key hygiene) or without one (direct key injection, the bridge default)", () => {
      // Proxy opt-in.
      expect(() =>
        makeBuildWiring({ db: fakeDb, spec: claudeSpec(), secrets, getClient: () => ({}) as never, source: "/x", modelProxyUrl: "http://marathon-proxy:8080" }),
      ).not.toThrow();
      // No proxy on the default bridge posture is NOW valid — direct key
      // injection is the default (model-proxy decision, §4.1); the runtime
      // enforces the posture-specific rule at nextTurn.
      expect(() => wire(claudeSpec())).not.toThrow();
    });

    it("fails closed on the locked-down posture (sandbox.network: none) until the internal-network spike lands (§7.1)", () => {
      expect(() =>
        makeBuildWiring({ db: fakeDb, spec: claudeSpec({ sandbox: { network: "none" } }), secrets, getClient: () => ({}) as never, source: "/x", modelProxyUrl: "http://marathon-proxy:8080" }),
      ).toThrow(/internal-network model-proxy wiring/);
    });

    it("rejects a non-Anthropic model policy (§13.1)", () => {
      expect(() =>
        makeBuildWiring({ db: fakeDb, spec: claudeSpec({ models: { default: "openai:gpt-4o" } }), secrets, getClient: () => ({}) as never, source: "/x", modelProxyUrl: "http://marathon-proxy:8080" }),
      ).toThrow(/requires Anthropic models/);
    });
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
      planRef: { repo: "acme/service", docPath: "docs/plan.md", approvedSha: "abc" },
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
