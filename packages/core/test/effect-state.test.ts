import { describe, expect, it } from "vitest";
import {
  assertEffectTransition,
  canEffectTransition,
  InvalidEffectTransitionError,
  payloadHashOf,
  proposedEffectKey,
} from "../src/effect-state";

describe("effect state machine (§7.9, Track 9)", () => {
  it("allows the propose → review → execute path", () => {
    expect(canEffectTransition("proposed", "approved")).toBe(true);
    expect(canEffectTransition("proposed", "rejected")).toBe(true);
    expect(canEffectTransition("proposed", "expired")).toBe(true);
    expect(canEffectTransition("approved", "executing")).toBe(true);
    expect(canEffectTransition("approved", "expired")).toBe(true);
    expect(canEffectTransition("executing", "executed")).toBe(true);
    expect(canEffectTransition("executing", "failed")).toBe(true);
  });

  it("forbids skipping review or re-running a terminal effect", () => {
    expect(canEffectTransition("proposed", "executing")).toBe(false);
    expect(canEffectTransition("proposed", "executed")).toBe(false);
    expect(canEffectTransition("executed", "executing")).toBe(false);
    expect(canEffectTransition("failed", "executing")).toBe(false);
    expect(canEffectTransition("rejected", "approved")).toBe(false);
    expect(canEffectTransition("expired", "approved")).toBe(false);
  });

  it("assertEffectTransition throws a typed error", () => {
    expect(() => assertEffectTransition("proposed", "approved")).not.toThrow();
    expect(() => assertEffectTransition("proposed", "executed")).toThrow(InvalidEffectTransitionError);
    try {
      assertEffectTransition("executed", "failed");
    } catch (e) {
      const err = e instanceof InvalidEffectTransitionError ? e : null;
      expect(err?.from).toBe("executed");
      expect(err?.to).toBe("failed");
    }
  });
});

describe("payloadHashOf (approval binding)", () => {
  it("is deterministic and key-order independent", () => {
    expect(payloadHashOf({ a: 1, b: "x" })).toBe(payloadHashOf({ b: "x", a: 1 }));
    expect(payloadHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the payload changes — voiding any prior approval", () => {
    expect(payloadHashOf({ repo: "a/b", number: 1 })).not.toBe(payloadHashOf({ repo: "a/b", number: 2 }));
  });
});

describe("proposedEffectKey", () => {
  it("bounds a proposal to (task, type, payload)", () => {
    const h = payloadHashOf({ n: 1 });
    const key = proposedEffectKey("task-1", "github.merge_pull_request", h);
    expect(key).toBe(`task:task-1:effect:github.merge_pull_request:${h.slice(0, 32)}`);
    expect(proposedEffectKey("task-2", "github.merge_pull_request", h)).not.toBe(key);
  });
});
