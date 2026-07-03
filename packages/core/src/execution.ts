import type { NewModelInvocation, PlanRef, VerificationResult } from "./entities";

/**
 * The durable resume checkpoint for a task (design.md §11.2). The base fields
 * cover generic step runners; the BUILD-stage fields are required for the
 * code-writing path (§11.2 "BUILD-stage checkpoints", §29), where the
 * checkpoint unit is one completed harness turn.
 */
export interface Checkpoint {
  completedSteps: string[];
  findings: string[];
  /** What the task is currently doing (status reporting, §15.3). */
  phase?: string;
  /** Index of the last completed harness turn; resume replays from here. */
  turnIndex?: number;
  /** Reference to the persisted session JSONL for between-turn resume. */
  sessionRef?: string;
  /** The pinned commit the workspace was materialized from (§29.1). */
  baseSha?: string;
  /** Reference to the stored `git diff base_sha..worktree` snapshot (§29.2)… */
  workspaceDiffRef?: string;
  /** …or the snapshot inline, when small enough to store with the checkpoint. */
  workspaceDiff?: string;
  /** Completed verification runs so far (§29.3) — interrupted runs count for nothing. */
  verification?: VerificationResult[];
  /** The merged plan being implemented (§29.1). */
  planRef?: PlanRef;
  /** Idempotency keys of durable effects already performed (safe to skip on replay). */
  completedEffects?: string[];
}

export const emptyCheckpoint = (): Checkpoint => ({ completedSteps: [], findings: [] });

/**
 * Tolerantly parse a stored checkpoint value, defaulting missing/garbage base
 * fields and passing the optional BUILD-stage fields through as stored.
 */
export function parseCheckpoint(value: unknown): Checkpoint {
  if (!value || typeof value !== "object") return emptyCheckpoint();
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
  return {
    ...(v as Partial<Checkpoint>),
    completedSteps: strings(v.completedSteps),
    findings: strings(v.findings),
  };
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
