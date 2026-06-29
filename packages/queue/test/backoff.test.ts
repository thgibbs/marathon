import { describe, expect, it } from "vitest";
import { backoffMs, classifyError } from "../src/backoff";

describe("classifyError", () => {
  it("matches common transient messages", () => {
    expect(classifyError(new Error("request timeout"))).toBe("transient");
    expect(classifyError(new Error("429 rate limit exceeded"))).toBe("transient");
    expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyError(new Error("upstream 503"))).toBe("transient");
  });

  it("treats everything else as permanent", () => {
    expect(classifyError(new Error("invalid tool input"))).toBe("permanent");
    expect(classifyError(new Error("permission denied"))).toBe("permanent");
  });
});

describe("backoffMs", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffMs(1, { baseMs: 100, factor: 2 })).toBe(100);
    expect(backoffMs(2, { baseMs: 100, factor: 2 })).toBe(200);
    expect(backoffMs(3, { baseMs: 100, factor: 2 })).toBe(400);
    expect(backoffMs(10, { baseMs: 100, factor: 2, maxMs: 1000 })).toBe(1000);
  });

  it("jitter stays within [raw/2, raw]", () => {
    for (let i = 0; i < 20; i++) {
      const v = backoffMs(3, { baseMs: 100, factor: 2, jitter: true });
      expect(v).toBeGreaterThanOrEqual(200);
      expect(v).toBeLessThanOrEqual(400);
    }
  });
});
