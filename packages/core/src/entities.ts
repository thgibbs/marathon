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

export interface Task {
  id: Id;
  tenantId: Id;
  agentId: Id | null;
  agentVersionId: Id | null;
  invokingUserId: Id | null;
  sourceType: SurfaceType;
  sourceRef: Record<string, unknown>;
  deliveryTargets: Record<string, unknown> | null;
  status: TaskStatus;
  inputText: string | null;
  summary: string | null;
  costUsd: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
}
