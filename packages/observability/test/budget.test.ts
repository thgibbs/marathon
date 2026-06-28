import { describe, expect, it } from "vitest";
import { evaluateBudget } from "../src/budget";

describe("evaluateBudget", () => {
  it("is ok well under the limit", () => {
    expect(evaluateBudget(1, { limitUsd: 10 })).toMatchObject({ state: "ok", ratio: 0.1 });
  });
  it("warns near the limit (default 0.8)", () => {
    expect(evaluateBudget(8.5, { limitUsd: 10 }).state).toBe("warn");
  });
  it("respects a custom warnRatio", () => {
    expect(evaluateBudget(5.5, { limitUsd: 10, warnRatio: 0.5 }).state).toBe("warn");
  });
  it("is exceeded at/over the limit", () => {
    expect(evaluateBudget(10, { limitUsd: 10 }).state).toBe("exceeded");
    expect(evaluateBudget(12, { limitUsd: 10 }).state).toBe("exceeded");
  });
});
