import { describe, expect, it } from "vitest";
import {
  ALL_TASK_STATUSES,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  type TaskStatus,
} from "../src/task-state";

describe("task state machine", () => {
  it("allows the happy path created -> queued -> running -> completed", () => {
    expect(canTransition("created", "queued")).toBe(true);
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
  });

  it("allows running to pause for input/approval and resume", () => {
    expect(canTransition("running", "waiting_for_approval")).toBe(true);
    expect(canTransition("waiting_for_approval", "running")).toBe(true);
    expect(canTransition("running", "waiting_for_input")).toBe(true);
    expect(canTransition("waiting_for_input", "running")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("created", "running")).toBe(false);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("failed", "completed")).toBe(false);
  });

  it("treats terminal states as having no outgoing transitions", () => {
    for (const status of ["completed", "failed", "cancelled", "expired"] as TaskStatus[]) {
      expect(isTerminal(status)).toBe(true);
      for (const to of ALL_TASK_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    }
  });

  it("assertTransition throws InvalidTransitionError on a bad move", () => {
    expect(() => assertTransition("completed", "running")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("created", "queued")).not.toThrow();
  });

  it("every status has a transition entry", () => {
    for (const status of ALL_TASK_STATUSES) {
      expect(() => canTransition(status, "failed")).not.toThrow();
    }
  });
});
