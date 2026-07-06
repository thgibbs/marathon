import { describe, expect, it } from "vitest";
import { type AgentSpec, parseAgentSpec, validateHarnessConfig } from "../src/index";

function spec(overrides: Partial<AgentSpec>): AgentSpec {
  return {
    name: "a",
    instructions: "do things",
    harness: "pi",
    tools: [],
    sandbox: { network: "bridge" },
    plans: { branch: "marathon-plans" },
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

  it("rejects claude-code when the proxy is not configured", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6" } }), {
        proxyConfigured: false,
      }),
    ).toThrow(/requires a configured model proxy/);
  });

  it("accepts claude-code with an Anthropic policy + proxy", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "claude-code", models: { default: "anthropic:claude-sonnet-4-6" } }), {
        proxyConfigured: true,
      }),
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
    expect(() => validateHarnessConfig(parsed, { proxyConfigured: true })).not.toThrow();
  });
});
