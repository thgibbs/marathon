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

  it("rejects codex with no model policy (K8 §4.3)", () => {
    expect(() => validateHarnessConfig(spec({ harness: "codex" }))).toThrow(/requires an OpenAI 'models' policy/);
  });

  it("rejects codex routed to a non-OpenAI model, fails closed (K8 §4.3)", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "codex", models: { default: "anthropic:claude-sonnet-4-6" } })),
    ).toThrow(/requires OpenAI models/);
    expect(() =>
      validateHarnessConfig(
        spec({ harness: "codex", models: { default: "openai:gpt-5-codex", build: "anthropic:claude-sonnet-4-6" } }),
      ),
    ).toThrow(/models\.build/);
  });

  it("accepts codex with an all-OpenAI policy (K8 §4.3)", () => {
    expect(() =>
      validateHarnessConfig(spec({ harness: "codex", models: { default: "openai:gpt-5-codex", draft: "openai:gpt-5" } })),
    ).not.toThrow();
  });

  it("parseAgentSpec accepts a codex spec; validation is a separate gate", () => {
    const parsed = parseAgentSpec({
      name: "forge",
      instructions: "x",
      harness: "codex",
      models: { default: "openai:gpt-5-codex" },
    });
    expect(parsed.harness).toBe("codex");
    expect(() => validateHarnessConfig(parsed)).not.toThrow();
  });

  it("does not warn on a standalone reviewer's 'on' list (§A.3a — reviewer ≠ owner)", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);

    // A doc-reviewer subscribes to design-review WITHOUT draft; a code-reviewer
    // to code-review WITHOUT build. Both are valid reviewer agents now.
    validateHarnessConfig(spec({ on: ["design-review"] }), warn);
    validateHarnessConfig(spec({ on: ["code-review"] }), warn);
    validateHarnessConfig(spec({ on: ["draft", "design-review", "build", "code-review"] }), warn);
    validateHarnessConfig(spec({}), warn); // omitted 'on'
    expect(warnings).toEqual([]);
  });
});
