import type { Id } from "./ids";
import type { TaskStatus } from "./task-state";

/** Core domain types, aligned with design.md §10. Tenant-scoped throughout. */

export type Role = "admin" | "agent_owner" | "developer" | "user" | "viewer";
export type SurfaceType = "slack" | "github" | "web" | "api" | "email" | "schedule";
export type AgentStatus = "draft" | "active" | "disabled" | "archived" | "deprecated";
export type AgentVersionStatus =
  | "draft" | "testing" | "published" | "rolled_back" | "deprecated";
export type FeedbackType = "thumbs_up" | "thumbs_down" | "free_text";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Tenant {
  id: Id;
  name: string;
  settings: Record<string, unknown>;
  retentionPolicy: Record<string, unknown> | null;
  defaultModelPolicy: Record<string, unknown> | null;
  budgetPolicy: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: Id;
  tenantId: Id;
  displayName: string | null;
  email: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserIdentity {
  id: Id;
  userId: Id;
  surfaceType: SurfaceType;
  externalId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: Id;
  tenantId: Id;
  name: string;
  displayName: string | null;
  description: string | null;
  ownerUserId: Id | null;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentVersion {
  id: Id;
  agentId: Id;
  versionNumber: number;
  status: AgentVersionStatus;
  instructions: string | null;
  modelPolicy: Record<string, unknown> | null;
  toolPolicy: Record<string, unknown> | null;
  memoryPolicy: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown> | null;
  createdBy: Id | null;
  createdAt: Date;
  publishedAt: Date | null;
}

/**
 * One place progress and results are delivered to (design §10.8): the same
 * shape as `source_ref`, tagged with its surface. A task's targets default to
 * [the source]; the loop task chain (K2) extends them (e.g. + the doc PR).
 */
export interface DeliveryTarget {
  surfaceType: SurfaceType;
  ref: Record<string, unknown>;
}

export interface Task {
  id: Id;
  tenantId: Id;
  agentId: Id | null;
  agentVersionId: Id | null;
  invokingUserId: Id | null;
  /** The task this one was chained from (e.g. doc task → implementation task). */
  sourceTaskId: Id | null;
  sourceType: SurfaceType;
  sourceRef: Record<string, unknown>;
  deliveryTargets: DeliveryTarget[] | null;
  status: TaskStatus;
  inputText: string | null;
  summary: string | null;
  /** Durable resume checkpoint (design.md §11.2). */
  checkpoint: Record<string, unknown> | null;
  costUsd: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
}

export interface ModelInvocation {
  id: Id;
  taskId: Id;
  taskStepId: Id | null;
  provider: string;
  model: string;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: string | null;
  error: string | null;
  createdAt: Date;
}

export type NewModelInvocation = {
  taskId: Id;
  taskStepId?: Id | null;
  provider: string;
  model: string;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  status?: string | null;
  error?: string | null;
};

export interface ApprovalRequest {
  id: Id;
  tenantId: Id;
  taskId: Id;
  toolInvocationId: Id | null;
  requestedByAgentId: Id | null;
  requestedFromUserId: Id | null;
  status: ApprovalStatus;
  actionSummary: string | null;
  riskLevel: RiskLevel | null;
  expiresAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: Id | null;
}

export type NewApprovalRequest = {
  tenantId: Id;
  taskId: Id;
  toolInvocationId?: Id | null;
  requestedByAgentId?: Id | null;
  requestedFromUserId?: Id | null;
  actionSummary?: string | null;
  riskLevel?: RiskLevel | null;
  expiresAt?: Date | null;
};

/** The merged plan an implementation task builds from (design §29.1). */
export interface PlanRef {
  repo: string;
  docPath: string;
  mergeCommitSha: string;
}

/** One verify command as run in-session (design §29.3). */
export interface VerificationResult {
  command: string;
  exitCode: number;
  summary: string;
}

export type CodeChangeState =
  | "building" | "submitted_draft" | "submitted_ready" | "merged" | "closed";

/**
 * The first-class record of one BUILD → DELIVER handoff (design §10.19, §29.8).
 * One row per implementation task; revisions (§29.6) update it.
 */
export interface CodeChange {
  id: Id;
  tenantId: Id;
  taskId: Id;
  repo: string;
  planRef: PlanRef;
  baseSha: string;
  branch: string;
  /** Idempotency anchor for submit (§29.4): same tree twice is a no-op. */
  treeHash: string | null;
  prNumber: number | null;
  prUrl: string | null;
  state: CodeChangeState;
  verification: VerificationResult[];
  createdAt: Date;
  updatedAt: Date;
}

export type NewCodeChange = {
  tenantId: Id;
  taskId: Id;
  repo: string;
  planRef: PlanRef;
  baseSha: string;
  branch: string;
};

export type DocumentRole = "produced" | "watched";

export interface DocumentArtifact {
  id: Id;
  tenantId: Id;
  surfaceType: string;
  location: Record<string, unknown>;
  title: string | null;
  role: DocumentRole | null;
  owningTaskId: Id | null;
  owningAgentId: Id | null;
  lastRevisionSeen: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewDocumentArtifact = {
  tenantId: Id;
  surfaceType?: string;
  location: Record<string, unknown>;
  title?: string | null;
  role?: DocumentRole | null;
  owningTaskId?: Id | null;
  owningAgentId?: Id | null;
  lastRevisionSeen?: string | null;
};
