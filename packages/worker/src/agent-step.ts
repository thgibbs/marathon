import type { Checkpoint, StepContext, StepResult } from "@marathon/core";
import { redactSecrets } from "@marathon/core";
import { Database } from "@marathon/db";
import type { AgentRequest, AgentRuntime } from "@marathon/agent";

export interface AgentStepOptions {
  /** Redact secrets from stored findings/trace (on by default). */
  redactTrace?: boolean;
}

/**
 * Adapts an {@link AgentRuntime} to the worker's StepRunner: each step is one
 * agent turn. The turn index is derived from the checkpoint, so resuming after a
 * crash continues from the next turn (no repeated model calls / effects).
 */
export function makeAgentStepRunner(
  runtime: AgentRuntime,
  request: AgentRequest,
  opts: AgentStepOptions = {},
) {
  return async ({ checkpoint }: StepContext): Promise<StepResult> => {
    const turnIndex = checkpoint.completedSteps.length;
    const turn = await runtime.nextTurn({ request, checkpoint });

    const text = redactSecrets(turn.text ?? "", { enabled: opts.redactTrace !== false });
    const next: Checkpoint = {
      completedSteps: [...checkpoint.completedSteps, `turn:${turnIndex}`],
      findings: [...checkpoint.findings, text],
    };

    return {
      stepType: `turn:${turnIndex}`,
      checkpoint: next,
      done: turn.done,
      modelInvocations: turn.modelInvocation ? [turn.modelInvocation] : [],
    };
  };
}

export interface AgentTaskStepOptions {
  modelRef: string;
  instructions?: string;
  redactTrace?: boolean;
}

/**
 * Like {@link makeAgentStepRunner}, but builds the agent request from the task
 * itself (loaded per step), so a single worker can run any agent task. Used by
 * the live Slack app (M5.5).
 */
export function makeAgentTaskStepRunner(db: Database, runtime: AgentRuntime, opts: AgentTaskStepOptions) {
  return async ({ taskId, checkpoint }: StepContext): Promise<StepResult> => {
    const task = await db.getTask(taskId);
    const request: AgentRequest = {
      taskId,
      instructions: opts.instructions ?? "You are Marathon, a concise engineering assistant.",
      input: task?.inputText ?? "",
      modelRef: opts.modelRef,
    };
    const turnIndex = checkpoint.completedSteps.length;
    const turn = await runtime.nextTurn({ request, checkpoint });
    const text = redactSecrets(turn.text ?? "", { enabled: opts.redactTrace !== false });
    const next: Checkpoint = {
      completedSteps: [...checkpoint.completedSteps, `turn:${turnIndex}`],
      findings: [...checkpoint.findings, text],
    };
    return {
      stepType: `turn:${turnIndex}`,
      checkpoint: next,
      done: turn.done,
      modelInvocations: turn.modelInvocation ? [turn.modelInvocation] : [],
    };
  };
}
