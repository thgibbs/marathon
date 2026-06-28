import type { Checkpoint, StepContext, StepResult } from "@marathon/core";
import { redactSecrets } from "@marathon/core";
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
