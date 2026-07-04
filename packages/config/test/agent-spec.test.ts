import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentSpec, parseAgentSpec } from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("parseAgentSpec (Track 12)", () => {
  it("accepts a minimal spec and trims instructions", () => {
    const spec = parseAgentSpec({ name: "forge", instructions: "  Build things.  \n" });
    expect(spec).toEqual({ name: "forge", instructions: "Build things." });
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
});

describe("agents/forge.yaml (design §21)", () => {
  it("loads as a valid spec whose instructions teach the corrected loop", async () => {
    const spec = await loadAgentSpec(join(repoRoot, "agents", "forge.yaml"));
    expect(spec.name).toBe("forge");
    expect(spec.displayName).toBe("Forge");
    expect(spec.instructions).toContain("delivery.report_pr");
    expect(spec.instructions).toContain("git.exec");
    expect(spec.instructions).toContain("ask_user");
    expect(spec.instructions).toContain("<<<UNTRUSTED");
  });
});
