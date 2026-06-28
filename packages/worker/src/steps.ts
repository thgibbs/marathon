import type { Checkpoint, StepContext, StepResult } from "@marathon/core";

/**
 * M1 synthetic work: a fixed list of named steps. The next step is whichever
 * comes after the ones already in `completedSteps`.
 */
export function makeSyntheticStepRunner(steps: string[]) {
  return ({ checkpoint }: StepContext): StepResult => {
    const idx = checkpoint.completedSteps.length;
    const step = steps[idx];
    if (step === undefined) {
      return { stepType: "noop", checkpoint, done: true };
    }
    const next: Checkpoint = {
      completedSteps: [...checkpoint.completedSteps, step],
      findings: [...checkpoint.findings, `did ${step}`],
    };
    return { stepType: step, checkpoint: next, done: next.completedSteps.length >= steps.length };
  };
}
