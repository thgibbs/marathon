import type { Checkpoint } from "./checkpoint";

export interface StepResult {
  stepType: string;
  /** The checkpoint AFTER applying this step. */
  checkpoint: Checkpoint;
  done: boolean;
}

export interface StepContext {
  taskId: string;
  checkpoint: Checkpoint;
}

/**
 * A step runner computes the next step from the current checkpoint. It must be a
 * pure function of (task, checkpoint) so resuming from a checkpoint re-derives
 * exactly the remaining work — never repeating completed steps.
 */
export type StepRunner = (ctx: StepContext) => Promise<StepResult> | StepResult;

/**
 * M1 synthetic work: a fixed list of named steps. The next step is whichever
 * comes after the ones already in `completedSteps`.
 */
export function makeSyntheticStepRunner(steps: string[]): StepRunner {
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
