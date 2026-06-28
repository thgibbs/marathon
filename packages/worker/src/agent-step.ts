import type { Checkpoint, StepContext, StepResult } from "@marathon/core";
import { redactSecrets } from "@marathon/core";
import { Database } from "@marathon/db";
import type { MemoryStore } from "@marathon/memory";
import { assertWithinBudget, type BudgetPolicy } from "@marathon/observability";
import type { AgentRequest, AgentRuntime } from "@marathon/agent";
import { buildAgentPrompt } from "./prompt";

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
  /** When set, recall is injected into the prompt (design §7.18). */
  memory?: MemoryStore;
  /** When set, model spend is enforced before each turn (M8); throws if exceeded. */
  budget?: { policy: BudgetPolicy; scope?: { agentId?: string } };
}

/**
 * Like {@link makeAgentStepRunner}, but builds the agent request from the task
 * itself (loaded per step), so a single worker can run any agent task. Used by
 * the live Slack app (M5.5).
 */
export function makeAgentTaskStepRunner(db: Database, runtime: AgentRuntime, opts: AgentTaskStepOptions) {
  return async ({ taskId, checkpoint }: StepContext): Promise<StepResult> => {
    const task = await db.getTask(taskId);
    // Enforce the spend budget before incurring more model cost (M8).
    if (opts.budget && task) {
      await assertWithinBudget(
        db,
        { tenantId: task.tenantId, agentId: opts.budget.scope?.agentId ?? task.agentId ?? undefined },
        opts.budget.policy,
      );
    }
    // Assemble instructions (persona) + recalled memory + the ask (design §7.18).
    const parts = task
      ? await buildAgentPrompt({ db, memory: opts.memory }, task, { basePersona: opts.instructions })
      : { instructions: opts.instructions ?? "You are Marathon, a concise engineering assistant.", input: "" };
    const request: AgentRequest = {
      taskId,
      instructions: parts.instructions,
      input: parts.input,
      modelRef: opts.modelRef,
      tenantId: task?.tenantId,
      agentId: task?.agentId ?? undefined,
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
