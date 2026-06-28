import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks within the window", () => {
    let now = 1000;
    const rl = new RateLimiter(2, 1000, () => now);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
  });

  it("resets after the window passes", () => {
    let now = 1000;
    const rl = new RateLimiter(1, 1000, () => now);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
    now += 1001;
    expect(rl.allow("k")).toBe(true);
  });

  it("tracks keys independently", () => {
    let now = 0;
    const rl = new RateLimiter(1, 1000, () => now);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("b")).toBe(true);
    expect(rl.allow("a")).toBe(false);
  });
});
