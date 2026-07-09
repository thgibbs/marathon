import type { Checkpoint, StepContext, StepResult, Task } from "@marathon/core";
import { fenceUntrusted, redactSecrets } from "@marathon/core";
import { Database } from "@marathon/db";
import type { MemoryStore } from "@marathon/memory";
import { assertWithinBudget, assertWithinTaskBudget, type BudgetPolicy } from "@marathon/observability";
import type { AgentRequest, AgentRuntime, AgentTurn } from "@marathon/agent";
import type { SurfaceMessage } from "@marathon/surface";
import type { ResolvedChatWorkspace } from "./chat-workspace-provider";
import { docDraftContract, docPathSlug } from "./documents";
import { buildAgentPrompt } from "./prompt";

/**
 * Fold a turn's wait state into the checkpoint + step result (Track 12,
 * §11.6): an asked question is recorded (`pendingQuestion`), a consumed answer
 * is cleared, and `waiting` propagates so the worker parks the task. The
 * turn's session pointer is persisted too — it is what lets the NEXT turn
 * (a durable-wait resume, a later turn) re-open the same harness session
 * instead of starting an amnesiac fresh one.
 */
function withWaitState(
  base: Checkpoint,
  turn: AgentTurn,
): { checkpoint: Checkpoint; waiting?: StepResult["waiting"]; done: boolean } {
  // The staged answer (if any) was handed to this turn — consumed either way.
  const { pendingUserInput: _consumed, pendingQuestion: _stale, ...rest } = base;
  if (turn.sessionRef !== undefined) rest.sessionRef = turn.sessionRef;
  if (turn.turnIndex !== undefined) rest.turnIndex = turn.turnIndex;
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
 * A runtime, or a resolver that picks the runtime for a task's owning agent
 * (multi-agent dispatch): with several configured agent specs, each gets its
 * own `AgentRuntime` (distinct tool grants + model policy), and a task runs on
 * the runtime for its `task.agentId`. A plain `AgentRuntime` keeps the
 * single-runtime behavior (every task on one runtime — unchanged).
 */
export type RuntimeFor = AgentRuntime | ((agentId: string | undefined) => AgentRuntime);

/** Resolve the concrete runtime for an agent id (identity for a plain runtime). */
export function resolveRuntimeFor(runtime: RuntimeFor, agentId: string | undefined): AgentRuntime {
  return typeof runtime === "function" ? runtime(agentId) : runtime;
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
   * Hard per-task cost cap (Track 15, §0.4): this task's own spend is checked
   * before each turn; an exceeded cap fails the turn (fail closed).
   */
  taskBudget?: BudgetPolicy;
  /**
   * Conversation context for the task's surface (Track 12, §7.18) — wire to
   * the surface adapter, e.g. `(task) => adapter.loadContext?.(task.sourceRef)`.
   * The result is fenced as untrusted in the prompt.
   */
  loadContext?: (task: Task) => Promise<SurfaceMessage[] | undefined> | SurfaceMessage[] | undefined;
  /**
   * Doc-task mode (§2b #16, the Slack remainder): when set, a task whose
   * source ref carries `kind: "doc_draft"` (the deterministic doc-task shape —
   * see `isDocDraftAsk`) gets the shared doc-tool CONTRACT in its trusted
   * instructions, and its final reply carries a deterministic outcome footer:
   * the drafted PR (evidence = the gateway-recorded DocumentArtifact) or an
   * explicit "nothing was committed" no-op. Requires the runtime to expose the
   * governed `document.create` tool and the gateway to be wired with
   * `makeDocumentPrRecorder` — same load-bearing wiring as the GitHub app.
   */
  docTasks?: {
    /** The ONE configured repo the doc PR targets. */
    repo: string;
    /** Directory drafted docs land in; default "docs". */
    docBasePath?: string;
  };
  /**
   * Chat-surface repo grounding (chat-repo.md §3.2). When set, each turn asks
   * the provider for a read-only checkout of the agent's repo (gated by access +
   * audience); the resolved binding is passed into `nextTurn` and disposed
   * afterwards, and the resolved commit is pinned on the checkpoint so a
   * `pinned`-mode task sees one consistent tree across its turns. Returns
   * `undefined` when the gate declines — the task simply runs ungrounded.
   */
  resolveWorkspace?: (
    task: Task,
    opts: { pinnedSha?: string },
  ) => Promise<ResolvedChatWorkspace | undefined>;
}

/** Is this task in the deterministic doc-draft shape (§2b #16)? */
function isDocDraftTask(task: Task | null): task is Task {
  return (task?.sourceRef as { kind?: string } | null | undefined)?.kind === "doc_draft";
}

/**
 * Like {@link makeAgentStepRunner}, but builds the agent request from the task
 * itself (loaded per step), so a single worker can run any agent task. Used by
 * the live Slack app (M5.5).
 */
export function makeAgentTaskStepRunner(db: Database, runtime: RuntimeFor, opts: AgentTaskStepOptions) {
  return async ({ taskId, checkpoint }: StepContext): Promise<StepResult> => {
    const task = await db.getTask(taskId);
    // Enforce the spend budgets before incurring more model cost: the
    // cumulative tenant/agent budget (M8) and the hard per-task cap (Track 15).
    if (opts.budget && task) {
      await assertWithinBudget(
        db,
        { tenantId: task.tenantId, agentId: opts.budget.scope?.agentId ?? task.agentId ?? undefined },
        opts.budget.policy,
      );
    }
    if (opts.taskBudget) await assertWithinTaskBudget(db, taskId, opts.taskBudget);
    // Doc-task mode (§2b #16): the deterministic doc-task shape gets the
    // shared doc-tool contract in the TRUSTED instructions, exactly like the
    // GitHub draft flow — the doc body only ever lands via document.create.
    const docDraft = opts.docTasks && isDocDraftTask(task);
    const contract = docDraft
      ? docDraftContract({
          repo: opts.docTasks!.repo,
          path: `${opts.docTasks!.docBasePath ?? "docs"}/${docPathSlug(task.inputText ?? "")}.md`,
        })
      : undefined;
    // Assemble instructions (persona) + recalled memory + surface context +
    // the ask (design §7.18) — every non-persona block fenced as untrusted.
    const parts = task
      ? await buildAgentPrompt({ db, memory: opts.memory }, task, {
          basePersona: opts.instructions,
          contract,
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

    // Chat-surface repo grounding (chat-repo.md §3.2): materialize a read-only
    // checkout for this turn (gated by the provider), pin its sha, dispose after.
    let grounded: ResolvedChatWorkspace | undefined;
    let groundedSha = checkpoint.groundedSha;
    if (task && opts.resolveWorkspace) {
      grounded = await opts.resolveWorkspace(task, { pinnedSha: checkpoint.groundedSha });
      if (grounded) groundedSha = grounded.sha; // pin on first resolve; re-affirm on resume
    }

    let turn: AgentTurn;
    try {
      // Multi-agent dispatch: run on the runtime for this task's owning agent.
      turn = await resolveRuntimeFor(runtime, task?.agentId ?? undefined).nextTurn({
        request,
        checkpoint,
        workspace: grounded?.workspace,
      });
    } finally {
      // The checkout is per-turn (§3.3, turn atomicity) — always torn down.
      await grounded?.dispose();
    }
    let text = redactSecrets(turn.text ?? "", { enabled: opts.redactTrace !== false });
    // Deterministic post-turn evidence check (§2b #16): the doc exists only if
    // the agent's own document.create left an artifact (written by the
    // gateway's onDocumentPr recorder). No artifact → the reply must report a
    // visible no-op instead of pretending a draft exists; text alone is never
    // treated as evidence.
    if (docDraft && turn.done && !turn.waiting) {
      const artifact = await db.findDocumentArtifactByTask(task.tenantId, taskId);
      const loc = (artifact?.location ?? {}) as { prNumber?: number };
      const footer =
        typeof loc.prNumber === "number"
          ? `Drafted design doc: PR #${loc.prNumber} (draft) — comment to revise, submit an approving review to execute.`
          : "No design document was produced by this run — nothing was committed. Mention me again to retry.";
      text = text.trim() ? `${text.trim()}\n\n${footer}` : footer;
    }
    const wait = withWaitState(
      {
        ...checkpoint,
        completedSteps: [...checkpoint.completedSteps, `turn:${turnIndex}`],
        findings: [...checkpoint.findings, text],
        // Pin the grounded commit so a `pinned`-mode resume re-materializes it.
        ...(groundedSha !== undefined ? { groundedSha } : {}),
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
