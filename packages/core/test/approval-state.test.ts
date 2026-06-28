import { describe, expect, it } from "vitest";
import {
  assertApprovalTransition,
  canApprovalTransition,
  InvalidApprovalTransitionError,
  isApprovalResolved,
  isExpired,
  needsReminder,
} from "../src/approval-state";

describe("approval state machine", () => {
  it("allows pending -> approved/rejected/expired/cancelled", () => {
    for (const to of ["approved", "rejected", "expired", "cancelled"] as const) {
      expect(canApprovalTransition("pending", to)).toBe(true);
    }
  });

  it("treats resolved states as terminal", () => {
    for (const s of ["approved", "rejected", "expired", "cancelled"] as const) {
      expect(isApprovalResolved(s)).toBe(true);
      expect(canApprovalTransition(s, "approved")).toBe(false);
    }
    expect(isApprovalResolved("pending")).toBe(false);
  });

  it("assertApprovalTransition throws on a bad move", () => {
    expect(() => assertApprovalTransition("approved", "rejected")).toThrow(
      InvalidApprovalTransitionError,
    );
    expect(() => assertApprovalTransition("pending", "approved")).not.toThrow();
  });
});

describe("isExpired / needsReminder", () => {
  it("isExpired only when a deadline has passed", () => {
    expect(isExpired(null, 1000)).toBe(false);
    expect(isExpired(new Date(2000), 1000)).toBe(false);
    expect(isExpired(new Date(1000), 1000)).toBe(true);
    expect(isExpired(new Date(500), 1000)).toBe(true);
  });

  it("needsReminder after the interval elapses", () => {
    const created = new Date(0);
    expect(needsReminder(created, null, 500, 1000)).toBe(false);
    expect(needsReminder(created, null, 1000, 1000)).toBe(true);
    expect(needsReminder(created, new Date(900), 1500, 1000)).toBe(false);
    expect(needsReminder(created, new Date(900), 1950, 1000)).toBe(true);
  });
});
