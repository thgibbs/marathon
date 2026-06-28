import type { Checkpoint } from "@marathon/core";

/** One model call's accounting, recorded as a ModelInvocation row. */
export interface ModelInvocationData {
  provider: string;
  model: string;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
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

export interface AgentTurn {
  /** Assistant text produced this turn. */
  text: string;
  /** Accounting for the model call made this turn (if any). */
  modelInvocation?: ModelInvocationData;
  /** Whether the agent has finished. */
  done: boolean;
}

export interface AgentTurnContext {
  request: AgentRequest;
  checkpoint: Checkpoint;
}

/**
 * The harness seam. The worker advances an agent one turn at a time so a crash
 * mid-loop resumes from the checkpoint. Implemented by {@link FakeAgentRuntime}
 * (deterministic, for tests/CI) and the real Pi adapter.
 */
export interface AgentRuntime {
  nextTurn(ctx: AgentTurnContext): Promise<AgentTurn>;
}
