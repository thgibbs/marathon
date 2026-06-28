import type { NewModelInvocation } from "./entities";

/** The durable resume checkpoint for a task (design.md §11.2). */
export interface Checkpoint {
  completedSteps: string[];
  findings: string[];
}

export const emptyCheckpoint = (): Checkpoint => ({ completedSteps: [], findings: [] });

/** Tolerantly parse a stored checkpoint value, defaulting missing/garbage fields. */
export function parseCheckpoint(value: unknown): Checkpoint {
  if (!value || typeof value !== "object") return emptyCheckpoint();
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
  return { completedSteps: strings(v.completedSteps), findings: strings(v.findings) };
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
export interface StepResult {
  stepType: string;
  /** Checkpoint AFTER applying this step. */
  checkpoint: Checkpoint;
  done: boolean;
  /** Model calls made during this step, persisted atomically with the step. */
  modelInvocations?: Array<Omit<NewModelInvocation, "taskId">>;
}

export type StepRunner = (ctx: StepContext) => Promise<StepResult> | StepResult;
