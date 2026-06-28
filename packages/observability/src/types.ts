export type TimelineEventType = "step" | "model_call" | "tool_call" | "approval" | "audit";

export interface TimelineEvent {
  at: Date;
  type: TimelineEventType;
  summary: string;
  status?: string;
  detail?: Record<string, unknown>;
}

export interface TaskReport {
  taskId: string;
  status: string;
  timeline: TimelineEvent[];
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  promptVersions: string[];
  failures: TimelineEvent[]; // events with an error/failed status
}

export interface BudgetPolicy {
  limitUsd: number;
  /** Ratio of the limit at which to warn (default 0.8). */
  warnRatio?: number;
}

export type BudgetState = "ok" | "warn" | "exceeded";

export interface BudgetStatus {
  spentUsd: number;
  limitUsd: number;
  ratio: number;
  state: BudgetState;
}

export interface MetricsSnapshot {
  tasksByStatus: Record<string, number>;
  jobsByStatus: Record<string, number>;
  deadLetter: number;
  toolErrorRate: number;
  modelErrorRate: number;
}
