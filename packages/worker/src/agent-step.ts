import type { Checkpoint, StepContext, StepResult, Task } from "@marathon/core";
import { fenceUntrusted, redactSecrets } from "@marathon/core";
import { Database } from "@marathon/db";
import type { MemoryStore } from "@marathon/memory";
import { assertWithinBudget, type BudgetPolicy } from "@marathon/observability";
import type { AgentRequest, AgentRuntime, AgentTurn } from "@marathon/agent";
import type { SurfaceMessage } from "@marathon/surface";
import { buildAgentPrompt } from "./prompt";

/**
 * Fold a turn's wait state into the checkpoint + step result (Track 12,
 * §11.6): an asked question is recorded (`pendingQuestion`), a consumed answer
 * is cleared, and `waiting` propagates so the worker parks the task.
 */
function withWaitState(
  base: Checkpoint,
  turn: AgentTurn,
): { checkpoint: Checkpoint; waiting?: StepResult["waiting"]; done: boolean } {
  // The staged answer (if any) was handed to this turn — consumed either way.
  const { pendingUserInput: _consumed, pendingQuestion: _stale, ...rest } = base;
  if (turn.waiting) {
    return {
      checkpoint: { ...rest, pendingQuestion: turn.waiting.question },
      waiting: { kind: "input", question: turn.waiting.question },
      done: false,
    };
  }
  return { checkpoint: rest, done: turn.done };
}

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
    // A staged user answer (durable-wait resume) becomes this turn's input.
    const input = checkpoint.pendingUserInput
      ? fenceUntrusted("user answer", checkpoint.pendingUserInput)
      : request.input;
    const turn = await runtime.nextTurn({ request: { ...request, input }, checkpoint });

    const text = redactSecrets(turn.text ?? "", { enabled: opts.redactTrace !== false });
    const wait = withWaitState(
      {
        ...checkpoint,
        completedSteps: [...checkpoint.completedSteps, `turn:${turnIndex}`],
        findings: [...checkpoint.findings, text],
      },
      turn,
    );

    return {
      stepType: `turn:${turnIndex}`,
      checkpoint: wait.checkpoint,
      done: wait.done,
      waiting: wait.waiting,
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
  /**
   * Conversation context for the task's surface (Track 12, §7.18) — wire to
   * the surface adapter, e.g. `(task) => adapter.loadContext?.(task.sourceRef)`.
   * The result is fenced as untrusted in the prompt.
   */
  loadContext?: (task: Task) => Promise<SurfaceMessage[] | undefined> | SurfaceMessage[] | undefined;
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
    // Assemble instructions (persona) + recalled memory + surface context +
    // the ask (design §7.18) — every non-persona block fenced as untrusted.
    const parts = task
      ? await buildAgentPrompt({ db, memory: opts.memory }, task, {
          basePersona: opts.instructions,
          context: (await opts.loadContext?.(task)) ?? undefined,
        })
      : { instructions: opts.instructions ?? "You are Marathon, a concise engineering assistant.", input: "" };
    // A staged user answer (durable-wait resume, Track 12) is this turn's ask.
    const input = checkpoint.pendingUserInput
      ? fenceUntrusted("user answer", checkpoint.pendingUserInput)
      : parts.input;
    const request: AgentRequest = {
      taskId,
      instructions: parts.instructions,
      input,
      modelRef: opts.modelRef,
      tenantId: task?.tenantId,
      agentId: task?.agentId ?? undefined,
    };
    const turnIndex = checkpoint.completedSteps.length;
    const turn = await runtime.nextTurn({ request, checkpoint });
    const text = redactSecrets(turn.text ?? "", { enabled: opts.redactTrace !== false });
    const wait = withWaitState(
      {
        ...checkpoint,
        completedSteps: [...checkpoint.completedSteps, `turn:${turnIndex}`],
        findings: [...checkpoint.findings, text],
      },
      turn,
    );
    return {
      stepType: `turn:${turnIndex}`,
      checkpoint: wait.checkpoint,
      done: wait.done,
      waiting: wait.waiting,
      modelInvocations: turn.modelInvocation ? [turn.modelInvocation] : [],
    };
  };
}
