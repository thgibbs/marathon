import { describe, expect, it } from "vitest";
import {
  computeCostUsd,
  ModelRegistry,
  parseModelRef,
  resolveModelRef,
  type ModelSpec,
} from "../src/index";

describe("parseModelRef", () => {
  it("splits provider and model", () => {
    expect(parseModelRef("anthropic:claude-sonnet")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });
  it("rejects malformed refs", () => {
    expect(() => parseModelRef("nope")).toThrow();
    expect(() => parseModelRef(":x")).toThrow();
    expect(() => parseModelRef("x:")).toThrow();
  });
});

describe("resolveModelRef", () => {
  const policy = { default: "openai:gpt-4o-mini", reasoning: "anthropic:claude-3-7-sonnet" };
  it("resolves a known role", () => {
    expect(resolveModelRef(policy, "reasoning")).toBe("anthropic:claude-3-7-sonnet");
  });
  it("falls back to default for unknown roles", () => {
    expect(resolveModelRef(policy, "missing")).toBe("openai:gpt-4o-mini");
    expect(resolveModelRef(policy)).toBe("openai:gpt-4o-mini");
  });
});

describe("computeCostUsd", () => {
  const spec: ModelSpec = { provider: "anthropic", model: "x", cost: { input: 3, output: 15 } };
  it("prices input + output per million tokens", () => {
    // 1000 input * 3/1e6 + 500 output * 15/1e6 = 0.003 + 0.0075
    expect(computeCostUsd(spec, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.0105, 9);
  });
  it("includes cache tokens when priced", () => {
    const s: ModelSpec = { provider: "p", model: "m", cost: { input: 1, output: 1, cacheRead: 0.1 } };
    expect(computeCostUsd(s, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 })).toBeCloseTo(1.1, 9);
  });
  it("prices an OpenRouter (openai-compatible) model the same way", () => {
    const orSpec: ModelSpec = { provider: "openrouter", model: "anthropic/claude", cost: { input: 3, output: 15 } };
    const direct: ModelSpec = { provider: "anthropic", model: "claude", cost: { input: 3, output: 15 } };
    const usage = { inputTokens: 1234, outputTokens: 567 };
    expect(computeCostUsd(orSpec, usage)).toBe(computeCostUsd(direct, usage));
  });
});

describe("ModelRegistry", () => {
  it("looks up builtin specs and throws on unknown", () => {
    const reg = new ModelRegistry();
    expect(reg.require("anthropic:claude-3-7-sonnet").cost.input).toBe(3);
    expect(reg.require("openai:gpt-4o-mini").cost.output).toBe(0.6);
    expect(() => reg.require("nope:nope")).toThrow();
  });
  it("accepts custom specs", () => {
    const reg = new ModelRegistry([{ provider: "openrouter", model: "x", cost: { input: 1, output: 2 } }]);
    expect(reg.require("openrouter:x").cost.output).toBe(2);
  });
});
