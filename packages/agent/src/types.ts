import type { Checkpoint } from "@marathon/core";

/** One model call's accounting, recorded as a ModelInvocation row. */
export interface ModelInvocationData {
  provider: string;
  model: string;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Actual billable dollars (0 under subscription auth); the budget sums this. */
  costUsd?: number | null;
  /** API-equivalent estimate — what the run would cost at API prices (§4.1). */
  estimatedCostUsd?: number | null;
  latencyMs?: number | null;
  status?: string | null;
  error?: string | null;
}

export interface AgentRequest {
  taskId: string;
  instructions: string;
  input: string;
  /** "provider:model" the runtime should use. */
  modelRef: string;
  /** Tenant/agent for governed tool calls + audit (per-task; the runtime is shared). */
  tenantId?: string;
  agentId?: string;
}

/**
 * The task's materialized code workspace, when this run is a BUILD stage
 * (design §29.2). The step runner provisions/tears it down; the runtime mounts
 * it into the sandbox and the agent's file/shell tools act on it.
 */
export interface AgentWorkspaceBinding {
  /** Host path of the workspace (mounted at /workspace in the sandbox). */
  dir: string;
  /** The pinned commit the workspace was materialized from (§29.1). */
  baseSha: string;
}

/**
 * Emitted after each completed harness turn (§11.2: checkpoint unit = one
 * turn). The caller persists a durable checkpoint from it — enriched with the
 * workspace diff for BUILD stages — so a crash mid-run resumes here.
 */
export interface AgentTurnCheckpoint {
  /** Index of the turn that just completed (monotonic across resumes). */
  turnIndex: number;
  /**
   * Session state as of this completed turn (for Pi: a snapshot of the session
   * JSONL). Resuming from it discards any later, incomplete turn.
   */
  sessionRef?: string;
  /** The model call made during this turn, if the harness reports per-turn usage. */
  modelInvocation?: ModelInvocationData;
}

/** A capped progress event (tool/shell activity) for the task timeline. */
export interface AgentProgressEvent {
  type: "tool_start" | "tool_end" | "turn_end";
  toolName?: string;
  /** Size-capped human-readable summary; never full command output. */
  summary: string;
}

export interface AgentTurn {
  /** Assistant text produced this turn. */
  text: string;
  /** Accounting for the model call made this turn (if any). */
  modelInvocation?: ModelInvocationData;
  /** Whether the agent has finished. */
  done: boolean;
  /**
   * The agent asked the user a clarifying question and ended its turn
   * (Track 12, §11.6): the run pauses durably (`waiting_for_input`) and
   * resumes — session re-opened via {@link sessionRef} — when the answer
   * arrives. Mutually exclusive with `done: true`.
   */
  waiting?: { question: string };
  /** Durable session reference after this call (resume input for the next). */
  sessionRef?: string;
  /** Index of the last completed harness turn. */
  turnIndex?: number;
}

export interface AgentTurnContext {
  request: AgentRequest;
  checkpoint: Checkpoint;
  /** Set when this run is a BUILD stage working a code workspace (§29.2). */
  workspace?: AgentWorkspaceBinding;
  /**
   * Durable per-turn checkpoint sink (K4). The runtime ensures every completed
   * turn is reported here; failures propagate (a run that cannot checkpoint
   * must not keep going as if it could resume).
   */
  onTurnCheckpoint?: (cp: AgentTurnCheckpoint) => Promise<void> | void;
  /** Progress/tool events for the task timeline (size-capped, best-effort). */
  onEvent?: (ev: AgentProgressEvent) => void;
}

/**
 * The harness seam. The worker advances an agent one call at a time so a crash
 * mid-loop resumes from the checkpoint; long multi-turn runs additionally
 * checkpoint per completed harness turn via {@link AgentTurnContext.onTurnCheckpoint}.
 * Implemented by {@link FakeAgentRuntime} (deterministic, for tests/CI), the
 * scripted BUILD runtime, and the real Pi adapter.
 */
export interface AgentRuntime {
  nextTurn(ctx: AgentTurnContext): Promise<AgentTurn>;
}
