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
  /** The clarifying question the agent is durably waiting on (Track 12, §11.6). */
  pendingQuestion?: string;
  /** The user's answer, staged for the next turn to consume (cleared once used). */
  pendingUserInput?: string;
}

export const emptyCheckpoint = (): Checkpoint => ({ completedSteps: [], findings: [] });

/**
 * Tolerantly parse a stored checkpoint value: missing/garbage base fields
 * default to empty, and each optional BUILD-stage field is shape-validated —
 * a malformed field is dropped rather than passed through mistyped, so resume
 * code can trust what the type says. This is a trust boundary: the stored
 * JSONB may be from an older writer or hand-edited.
 */
export function parseCheckpoint(value: unknown): Checkpoint {
  if (!value || typeof value !== "object") return emptyCheckpoint();
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
  const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
  const int = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isInteger(x) ? x : undefined;

  const cp: Checkpoint = {
    completedSteps: strings(v.completedSteps),
    findings: strings(v.findings),
  };
  // Assign optionals only when valid, so absent and malformed look the same.
  const set = <K extends keyof Checkpoint>(key: K, val: Checkpoint[K] | undefined): void => {
    if (val !== undefined) cp[key] = val;
  };
  set("phase", str(v.phase));
  set("turnIndex", int(v.turnIndex));
  set("sessionRef", str(v.sessionRef));
  set("baseSha", str(v.baseSha));
  set("workspaceDiffRef", str(v.workspaceDiffRef));
  set("workspaceDiff", str(v.workspaceDiff));
  set("verification", parseVerification(v.verification));
  set("planRef", parsePlanRef(v.planRef));
  if (Array.isArray(v.completedEffects)) set("completedEffects", strings(v.completedEffects));
  set("pendingQuestion", str(v.pendingQuestion));
  set("pendingUserInput", str(v.pendingUserInput));
  return cp;
}

function parseVerification(x: unknown): VerificationResult[] | undefined {
  if (!Array.isArray(x)) return undefined;
  // Drop malformed entries, keep the valid rest.
  return x.filter(
    (e): e is VerificationResult =>
      !!e &&
      typeof e === "object" &&
      typeof (e as VerificationResult).command === "string" &&
      typeof (e as VerificationResult).exitCode === "number" &&
      typeof (e as VerificationResult).summary === "string",
  );
}

function parsePlanRef(x: unknown): PlanRef | undefined {
  if (!x || typeof x !== "object") return undefined;
  const p = x as PlanRef;
  return typeof p.repo === "string" &&
    typeof p.docPath === "string" &&
    typeof p.mergeCommitSha === "string"
    ? { repo: p.repo, docPath: p.docPath, mergeCommitSha: p.mergeCommitSha }
    : undefined;
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
  /**
   * A durable human wait (Track 12, §11.6): the agent asked a clarifying
   * question and ended its turn. The worker parks the task
   * (`waiting_for_input`) instead of completing or requeueing it; a surface
   * reply resumes it with the answer.
   */
  waiting?: { kind: "input"; question: string };
  /** Model calls made during this step, persisted atomically with the step. */
  modelInvocations?: Array<Omit<NewModelInvocation, "taskId">>;
}

export type StepRunner = (ctx: StepContext) => Promise<StepResult> | StepResult;
