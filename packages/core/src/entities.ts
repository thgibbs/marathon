import { stableStringify } from "./idempotency";
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

/**
 * Risk classification axes (design §7.8) — retires the single
 * `riskLevel`/`destructive` model. An effect is classified on all four axes;
 * its default handling mode is a function of them plus the connector's
 * capability profile.
 */
export interface RiskAxes {
  /** Can the effect be undone? (edit a draft → delete a record) */
  reversible: boolean;
  /** Does it move info from a higher-trust source to a lower-trust sink? (the exfil axis) */
  crossesTrustBoundary: boolean;
  /** How broadly the effect is visible. */
  audience: "private" | "team" | "tenant" | "external" | "public";
  /** Does it spend money or scarce resources? */
  costly: boolean;
}

/** A tool's default handling mode (design §7.8, §10.6). */
export type ToolDefaultMode = "autonomous" | "native_review" | "proposed_effect" | "disabled";

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

/** How a surface identity was proven (design §7.20, §10.2) — never typed by hand. */
export type IdentityVerificationMethod = "oauth" | "idp" | "admin_asserted";

/** A failed token refresh marks an identity `stale` (→ deny) until re-verified. */
export type IdentityStatus = "active" | "stale" | "revoked";

/**
 * A surface identity, unique within a tenant (design §10.2):
 * `unique(tenant_id, surface_type, external_id)`.
 */
export interface UserIdentity {
  id: Id;
  userId: Id;
  tenantId: Id;
  surfaceType: SurfaceType;
  externalId: string;
  verifiedAt: Date | null;
  verificationMethod: IdentityVerificationMethod | null;
  status: IdentityStatus;
  /** Optional user-to-server token ref: access checks *as the user* (§7.20, §12.3). */
  credentialRef: string | null;
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

/** Append targets, deduping structurally (webhook/tool retries must converge). */
export function mergeDeliveryTargets(
  existing: DeliveryTarget[] | null | undefined,
  ...added: DeliveryTarget[]
): DeliveryTarget[] {
  const out: DeliveryTarget[] = [];
  const seen = new Set<string>();
  for (const t of [...(existing ?? []), ...added]) {
    const key = stableStringify(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
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
  /** Actual billable dollars (0 under subscription auth); the budget sums this. */
  costUsd: number | null;
  /** API-equivalent estimate — what the run would cost at API prices (§4.1). */
  estimatedCostUsd: number | null;
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
  estimatedCostUsd?: number | null;
  latencyMs?: number | null;
  status?: string | null;
  error?: string | null;
};

export interface ApprovalRequest {
  id: Id;
  tenantId: Id;
  taskId: Id;
  /** For gateway-gated tool calls. */
  toolInvocationId: Id | null;
  /** For high-risk effects (design §10.17) — approval binds to the proposal's payload hash. */
  proposedEffectId: Id | null;
  requestedByAgentId: Id | null;
  requestedFromUserId: Id | null;
  status: ApprovalStatus;
  actionSummary: string | null;
  riskAxes: RiskAxes | null;
  expiresAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: Id | null;
}

export type NewApprovalRequest = {
  tenantId: Id;
  taskId: Id;
  toolInvocationId?: Id | null;
  proposedEffectId?: Id | null;
  requestedByAgentId?: Id | null;
  requestedFromUserId?: Id | null;
  actionSummary?: string | null;
  riskAxes?: RiskAxes | null;
  expiresAt?: Date | null;
};

/** Lifecycle of a proposed effect (design §10.17, §7.9). */
export type EffectExecutionState =
  | "proposed" | "approved" | "rejected" | "expired" | "executing" | "executed" | "failed";

/**
 * A high-risk external effect proposed by the model and — if approved —
 * performed by the non-model executor (design §7.9, §10.17). The model never
 * executes these directly. Deferred behind the kernel (M10), but modeled now so
 * schema and types no longer encode the destructive-approval model.
 */
export interface ProposedEffect {
  id: Id;
  tenantId: Id;
  taskId: Id;
  /** Connector identifier; a loose string until ConnectorInstallation is modeled. */
  connectorId: string | null;
  /** slack_post | email_send | doc_delete | github_merge | ... (typed per connector). */
  effectType: string;
  /** Destination / resource. */
  target: Record<string, unknown>;
  /** The EXACT proposed content or mutation. */
  payload: Record<string, unknown>;
  /** Approval binds to this; a changed payload voids approval. */
  payloadHash: string;
  /** Edits create a new version; approval applies to exactly one. */
  proposalVersion: number;
  /** What the agent read to produce this (decision support + forensics). */
  provenance: Record<string, unknown> | null;
  riskAxes: RiskAxes | null;
  rollbackPlan: string | null;
  reviewerId: Id | null;
  /** Checked against target resource, effect type, and blast radius. */
  reviewerAuthority: string | null;
  approvalExpiresAt: Date | null;
  /** Bounds execution to at most once. */
  idempotencyKey: string;
  executionState: EffectExecutionState;
  createdAt: Date;
  resolvedAt: Date | null;
  executedAt: Date | null;
}

export type NewProposedEffect = {
  tenantId: Id;
  taskId: Id;
  connectorId?: string | null;
  effectType: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash: string;
  provenance?: Record<string, unknown> | null;
  riskAxes?: RiskAxes | null;
  rollbackPlan?: string | null;
  approvalExpiresAt?: Date | null;
  idempotencyKey: string;
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
