import { describe, expect, it } from "vitest";
import { emptyCheckpoint, parseCheckpoint } from "../src/checkpoint";

describe("checkpoint codec", () => {
  it("emptyCheckpoint has empty arrays", () => {
    expect(emptyCheckpoint()).toEqual({ completedSteps: [], findings: [] });
  });

  it("round-trips a valid checkpoint", () => {
    const cp = { completedSteps: ["a", "b"], findings: ["did a", "did b"] };
    expect(parseCheckpoint(cp)).toEqual(cp);
  });

  it("defaults null / garbage to an empty checkpoint", () => {
    expect(parseCheckpoint(null)).toEqual(emptyCheckpoint());
    expect(parseCheckpoint(undefined)).toEqual(emptyCheckpoint());
    expect(parseCheckpoint("nope")).toEqual(emptyCheckpoint());
    expect(parseCheckpoint(42)).toEqual(emptyCheckpoint());
  });

  it("filters non-string entries and missing fields", () => {
    expect(parseCheckpoint({ completedSteps: ["a", 1, null], findings: undefined })).toEqual({
      completedSteps: ["a"],
      findings: [],
    });
  });
});
