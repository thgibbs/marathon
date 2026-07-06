import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { grantFamilies, loadAgentSpec, loadAgentSpecs, parseAgentSpec, resolveAgentsDir } from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("parseAgentSpec (Tracks 12 + 14)", () => {
  it("accepts a minimal spec, trims instructions, and applies kernel defaults", () => {
    const spec = parseAgentSpec({ name: "forge", instructions: "  Build things.  \n" });
    expect(spec).toEqual({
      name: "forge",
      instructions: "Build things.",
      harness: "pi",
      tools: [],
      sandbox: { network: "bridge" },
      plans: { branch: "marathon-plans" },
    });
  });

  it("parses plans.branch and refuses the agent push namespace (§29.1a)", () => {
    const spec = parseAgentSpec({ name: "forge", instructions: "x", plans: { branch: "design-plans" } });
    expect(spec.plans).toEqual({ branch: "design-plans" });
    // The plans branch is an approval boundary — it cannot live in the prefix
    // rulesets leave open to agent pushes.
    expect(() => parseAgentSpec({ name: "forge", instructions: "x", plans: { branch: "marathon/plans" } })).toThrow(
      /push namespace/,
    );
    expect(() => parseAgentSpec({ name: "forge", instructions: "x", plans: { branch: "  " } })).toThrow(/plans.branch/);
  });

  it("carries display_name and description through", () => {
    const spec = parseAgentSpec({
      name: "forge",
      display_name: "Forge",
      description: "flagship",
      instructions: "x",
    });
    expect(spec.displayName).toBe("Forge");
    expect(spec.description).toBe("flagship");
  });

  it("rejects bad names, missing instructions, and non-mappings", () => {
    expect(() => parseAgentSpec({ name: "Forge!", instructions: "x" })).toThrow(/'name'/);
    expect(() => parseAgentSpec({ name: "forge" })).toThrow(/'instructions'/);
    expect(() => parseAgentSpec({ name: "forge", instructions: "   " })).toThrow(/'instructions'/);
    expect(() => parseAgentSpec("nope")).toThrow(/YAML mapping/);
    expect(() => parseAgentSpec(null)).toThrow(/YAML mapping/);
  });

  it("parses the full Track 14 config", () => {
    const spec = parseAgentSpec({
      name: "forge",
      instructions: "x",
      harness: "pi",
      repo: "acme/widgets",
      tools: [
        "delivery.report_pr",
        { tool: "github.exec", families: ["pr view", "pr create"] },
        { name: "git.exec", families: ["push"] },
      ],
      sandbox: { network: "none" },
      models: { default: "openai:gpt-4o-mini", reasoning: "openai:gpt-4o" },
      budget: { limit_usd: 5, warn_ratio: 0.8 },
      keywords: ["code", "implement"],
    });
    expect(spec.repo).toBe("acme/widgets");
    expect(spec.tools).toEqual([
      { tool: "delivery.report_pr" },
      { tool: "github.exec", families: ["pr view", "pr create"] },
      { tool: "git.exec", families: ["push"] },
    ]);
    expect(spec.sandbox.network).toBe("none");
    expect(spec.models).toEqual({ default: "openai:gpt-4o-mini", reasoning: "openai:gpt-4o" });
    expect(spec.budget).toEqual({ limitUsd: 5, warnRatio: 0.8 });
    expect(spec.keywords).toEqual(["code", "implement"]);
    expect(grantFamilies(spec, "github.exec")).toEqual(["pr view", "pr create"]);
    expect(grantFamilies(spec, "delivery.report_pr")).toBeUndefined();
  });

  it("rejects invalid harness, repo, sandbox, models, and budget values", () => {
    const base = { name: "forge", instructions: "x" };
    expect(() => parseAgentSpec({ ...base, harness: "gpt" })).toThrow(/'harness'/);
    expect(() => parseAgentSpec({ ...base, repo: "not-a-repo" })).toThrow(/'repo'/);
    expect(() => parseAgentSpec({ ...base, tools: [{ families: ["x"] }] })).toThrow(/tools\[0\]/);
    expect(() => parseAgentSpec({ ...base, sandbox: { network: "host" } })).toThrow(/'sandbox.network'/);
    expect(() => parseAgentSpec({ ...base, models: { reasoning: "openai:gpt-4o" } })).toThrow(/'models.default'/);
    expect(() => parseAgentSpec({ ...base, models: { default: "gpt-4o" } })).toThrow(/'models.default'/);
    expect(() => parseAgentSpec({ ...base, budget: { limit_usd: 0 } })).toThrow(/'budget.limit_usd'/);
    expect(() => parseAgentSpec({ ...base, budget: { limit_usd: 1, warn_ratio: 2 } })).toThrow(/'budget.warn_ratio'/);
  });
});

describe("agents/forge.yaml (design §21.0)", () => {
  it("loads as a full-config spec whose instructions teach the corrected loop", async () => {
    const spec = await loadAgentSpec(join(repoRoot, "agents", "forge.yaml"));
    expect(spec.name).toBe("forge");
    expect(spec.displayName).toBe("Forge");
    expect(spec.harness).toBe("pi");
    expect(spec.sandbox.network).toBe("bridge");
    expect(spec.tools.map((t) => t.tool)).toEqual(
      expect.arrayContaining(["github.exec", "git.exec", "delivery.report_pr"]),
    );
    expect(grantFamilies(spec, "git.exec")).toEqual(expect.arrayContaining(["push"]));
    expect(spec.models?.default).toMatch(/:/);
    expect(spec.budget?.limitUsd).toBeGreaterThan(0);
    expect(spec.instructions).toContain("delivery.report_pr");
    expect(spec.instructions).toContain("git.exec");
    expect(spec.instructions).toContain("ask_user");
    expect(spec.instructions).toContain("<<<UNTRUSTED");
  });

  it("loadAgentSpecs reads the agents directory (first file = default agent)", async () => {
    const specs = await loadAgentSpecs(join(repoRoot, "agents"));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.map((s) => s.name)).toContain("forge");
  });

  it("a <name>.local.yaml overrides the committed spec of the same name, keeping its position", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    const base = (name: string, extra = "") =>
      `name: ${name}\ninstructions: base ${name}\nrepo: acme/shipped\n${extra}`;
    writeFileSync(join(dir, "forge.yaml"), base("forge"));
    writeFileSync(join(dir, "zed.yaml"), base("zed")); // sorts after forge → forge stays default
    // The developer's git-ignored override pins a different repo for the same agent.
    writeFileSync(join(dir, "forge.local.yaml"), "name: forge\ninstructions: local forge\nrepo: me/dogfood");

    const specs = await loadAgentSpecs(dir);
    expect(specs.map((s) => s.name)).toEqual(["forge", "zed"]); // forge still first (default)
    const forge = specs.find((s) => s.name === "forge");
    expect(forge?.repo).toBe("me/dogfood"); // override won
    expect(forge?.instructions).toBe("local forge");
    expect(specs.find((s) => s.name === "zed")?.repo).toBe("acme/shipped"); // untouched
  });

  it("a .local.yaml with an unmatched name adds a local-only agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "forge.yaml"), "name: forge\ninstructions: base");
    writeFileSync(join(dir, "scratch.local.yaml"), "name: scratch\ninstructions: local only");
    const names = (await loadAgentSpecs(dir)).map((s) => s.name);
    expect(names).toEqual(["forge", "scratch"]);
  });

  it("resolveAgentsDir finds a relative dir by walking UP (live apps run from package cwds)", () => {
    // The live entrypoints run with demos/<app> as cwd; the default relative
    // "agents" must resolve to the repo root's directory, not demos/<app>/agents.
    expect(resolveAgentsDir("agents", join(repoRoot, "demos", "github-app"))).toBe(join(repoRoot, "agents"));
    // Absolute paths pass through untouched.
    expect(resolveAgentsDir(join(repoRoot, "agents"), "/anywhere")).toBe(join(repoRoot, "agents"));
    // Nothing found anywhere: fall back to plain resolution so the caller's
    // readdir error names the path that was tried.
    expect(resolveAgentsDir("no-such-dir-xyz", join(repoRoot, "demos"))).toBe(join(repoRoot, "demos", "no-such-dir-xyz"));
  });
});
