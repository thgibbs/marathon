import { describe, expect, it } from "vitest";
import { emptyCheckpoint } from "../src/checkpoint";
import { makeSyntheticStepRunner } from "../src/steps";

describe("synthetic step runner", () => {
  const steps = ["load_context", "plan", "finalize"];

  it("produces the first step from an empty checkpoint", async () => {
    const run = makeSyntheticStepRunner(steps);
    const res = await run({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(res.stepType).toBe("load_context");
    expect(res.checkpoint.completedSteps).toEqual(["load_context"]);
    expect(res.done).toBe(false);
  });

  it("resumes from a checkpoint without repeating completed steps", async () => {
    const run = makeSyntheticStepRunner(steps);
    const res = await run({
      taskId: "t1",
      checkpoint: { completedSteps: ["load_context"], findings: ["did load_context"] },
    });
    expect(res.stepType).toBe("plan");
    expect(res.checkpoint.completedSteps).toEqual(["load_context", "plan"]);
    expect(res.done).toBe(false);
  });

  it("marks done on the last step", async () => {
    const run = makeSyntheticStepRunner(steps);
    const res = await run({
      taskId: "t1",
      checkpoint: { completedSteps: ["load_context", "plan"], findings: [] },
    });
    expect(res.stepType).toBe("finalize");
    expect(res.done).toBe(true);
  });

  it("returns a noop/done when all steps are complete", async () => {
    const run = makeSyntheticStepRunner(steps);
    const res = await run({
      taskId: "t1",
      checkpoint: { completedSteps: [...steps], findings: [] },
    });
    expect(res.stepType).toBe("noop");
    expect(res.done).toBe(true);
  });
});
