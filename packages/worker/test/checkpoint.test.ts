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

  it("round-trips BUILD-stage fields (design §11.2 / §29) — resume must not drop them", () => {
    const cp = {
      completedSteps: ["turn:0"],
      findings: ["edited handler"],
      phase: "verifying",
      turnIndex: 1,
      sessionRef: "sessions/task-1.jsonl",
      baseSha: "abc123",
      workspaceDiffRef: "diffs/task-1-turn-1.patch",
      verification: [{ command: "pnpm test", exitCode: 0, summary: "193 passed" }],
      planRef: { repo: "acme/app", docPath: "design/plan.md", mergeCommitSha: "abc123" },
      completedEffects: ["task-1:github.submit_code_changes:xyz"],
    };
    expect(parseCheckpoint(cp)).toEqual(cp);
  });
});
