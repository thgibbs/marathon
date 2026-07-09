import { describe, expect, it } from "vitest";
import { type AgentSpec, parseAgentSpec, validateHarnessConfig } from "../src/index";

function spec(overrides: Partial<AgentSpec>): AgentSpec {
  return {
    name: "a",
    instructions: "do things",
    harness: "pi",
    tools: [],
    sandbox: { network: "bridge" },
    chat: { groundOnRepo: false, groundRef: "pinned", trustedDeployment: false },
    ...overrides,
  };
}

describe("validateHarnessConfig (K7 §13.1 fail-closed)", () => {
  it("is a no-op for the Pi harness", () => {
    expect(() => validateHarnessConfig(spec({ harness: "pi", models: { default: "openai:gpt-4o" } }))).not.toThrow();
  });

  it("rejects claude-code with no model policy (deployment default may be OpenAI)", () => {
    expect(() => validateHarnessConfig(spec({ harness: "claude-code" }))).toThrow(/requires an Anthropic 'models' policy/);
  });

  it("rejects claude-code routed to a non-Anthropic model", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "claude-code", models: { default: "openai:gpt-4o" } })),
    ).toThrow(/requires Anthropic models/);
    expect(() =>
      validateHarnessConfig(
        spec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6", build: "openai:gpt-4o" } }),
      ),
    ).toThrow(/models\.build/);
  });

  it("does NOT require a model proxy — direct key injection is the bridge default (§4.1)", () => {
    // The proxy is only required under locked-down egress, which the runtime
    // enforces (resolveModelAccessEnv) — not this config-load gate.
    expect(() =>
      validateHarnessConfig(spec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6" } })),
    ).not.toThrow();
  });

  it("accepts claude-code with an Anthropic policy", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6" } })),
    ).not.toThrow();
  });

  it("parseAgentSpec accepts a claude-code spec; validation is a separate gate", () => {
    const parsed = parseAgentSpec({
      name: "forge",
      instructions: "x",
      harness: "claude-code",
      models: { default: "anthropic:claude-sonnet-4-6" },
    });
    expect(parsed.harness).toBe("claude-code");
    expect(() => validateHarnessConfig(parsed)).not.toThrow();
  });

  it("warns (not fails) on an 'on' list that can never be dispatched to (§A.4 item 4)", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);

    validateHarnessConfig(spec({ on: ["design-review"] }), warn);
    expect(warnings).toEqual([expect.stringContaining("'design-review' without 'draft'")]);

    warnings.length = 0;
    validateHarnessConfig(spec({ on: ["code-review"] }), warn);
    expect(warnings).toEqual([expect.stringContaining("'code-review' without 'build'")]);

    warnings.length = 0;
    validateHarnessConfig(spec({ on: ["draft", "design-review", "build", "code-review"] }), warn);
    expect(warnings).toEqual([]);

    warnings.length = 0;
    validateHarnessConfig(spec({}), warn); // omitted 'on' — no warning
    expect(warnings).toEqual([]);
  });
});
