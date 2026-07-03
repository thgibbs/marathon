import { describe, expect, it } from "vitest";
import {
  deliveryTargetKey,
  implementationTaskKey,
  stableStringify,
  surfaceEventKey,
  taskToolInputKey,
} from "../src/idempotency";

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

  it("implementationTaskKey is one key per merged plan version (§29.1)", () => {
    const k = implementationTaskKey("o/r", "docs/plan.md", "sha1");
    expect(k).toBe("implement:o/r:docs/plan.md:sha1");
    // a revised-and-re-merged plan is a new version -> a new key
    expect(implementationTaskKey("o/r", "docs/plan.md", "sha2")).not.toBe(k);
  });

  it("deliveryTargetKey is stable per (task, target, kind), ref key-order independent", () => {
    const t1 = { surfaceType: "github", ref: { repo: "o/r", number: 1 } };
    const t1Reordered = { surfaceType: "github", ref: { number: 1, repo: "o/r" } };
    const k = deliveryTargetKey("t1", t1, "result");
    expect(deliveryTargetKey("t1", t1Reordered, "result")).toBe(k);
    expect(deliveryTargetKey("t1", t1, "progress")).not.toBe(k);
    expect(deliveryTargetKey("t2", t1, "result")).not.toBe(k);
    expect(deliveryTargetKey("t1", { surfaceType: "github", ref: { repo: "o/r", number: 2 } }, "result")).not.toBe(k);
  });
});
