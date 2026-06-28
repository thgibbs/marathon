import { describe, expect, it } from "vitest";
import { stableStringify, surfaceEventKey, taskToolInputKey } from "../src/idempotency";

describe("idempotency keys", () => {
  it("surfaceEventKey is deterministic", () => {
    expect(surfaceEventKey("slack", "evt-1")).toBe("surface:slack:evt-1");
    expect(surfaceEventKey("slack", "evt-1")).toBe(surfaceEventKey("slack", "evt-1"));
    expect(surfaceEventKey("github", "evt-1")).not.toBe(surfaceEventKey("slack", "evt-1"));
  });

  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("taskToolInputKey is stable regardless of input key order", () => {
    const k1 = taskToolInputKey("t1", "github.read", { repo: "x", number: 1 });
    const k2 = taskToolInputKey("t1", "github.read", { number: 1, repo: "x" });
    expect(k1).toBe(k2);
  });

  it("taskToolInputKey changes with different input", () => {
    const k1 = taskToolInputKey("t1", "github.read", { number: 1 });
    const k2 = taskToolInputKey("t1", "github.read", { number: 2 });
    expect(k1).not.toBe(k2);
  });
});
