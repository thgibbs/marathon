import {
  assertApprovalTransition,
  runOnce,
  taskToolInputKey,
  type ApprovalRequest,
  type Id,
  type RiskAxes,
} from "@marathon/core";
import { Database } from "@marathon/db";
import { ToolGateway, type ToolInput, type ToolResult } from "@marathon/tools";

export interface ApprovalRequestInput {
  tenantId: Id;
  taskId: Id;
  agentId?: Id;
  requestedFromUserId?: Id;
  actionSummary: string;
  riskAxes?: RiskAxes;
  expiresInMs?: number;
}

/**
 * Durable approval orchestration (design.md §7.9, §11.6). A destructive tool
 * call pauses the task (waiting_for_approval) without holding a process; on
 * approve, the action runs exactly once. Surface-agnostic — the surface only
 * renders the prompt and feeds back the decision.
 */
export class ApprovalService {
  constructor(private readonly db: Database) {}

  async request(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const expiresAt = input.expiresInMs ? new Date(Date.now() + input.expiresInMs) : null;
    const ar = await this.db.createApprovalRequest({
      tenantId: input.tenantId,
      taskId: input.taskId,
      requestedByAgentId: input.agentId ?? null,
      requestedFromUserId: input.requestedFromUserId ?? null,
      actionSummary: input.actionSummary,
      riskAxes: input.riskAxes ?? null,
      expiresAt,
    });
    await this.db.transitionTask(input.taskId, "waiting_for_approval");
    await this.db.write({
      tenantId: input.tenantId,
      eventType: "approval.requested",
      summary: input.actionSummary,
      targetType: "approval",
      targetId: ar.id,
      actorAgentId: input.agentId ?? null,
    });
    return ar;
  }

  async approve(approvalId: Id, byUserId?: Id): Promise<ApprovalRequest> {
    return this.resolve(approvalId, "approved", byUserId, "approval.approved");
  }

  async reject(approvalId: Id, byUserId?: Id): Promise<ApprovalRequest> {
    return this.resolve(approvalId, "rejected", byUserId, "approval.rejected");
  }

  /** Expire all pending approvals past their deadline; resume their tasks. */
  async expireDue(now: Date = new Date()): Promise<number> {
    const due = await this.db.listExpiredApprovals(now);
    for (const ar of due) {
      const resolved = await this.db.resolveApprovalRequest(ar.id, "expired");
      if (!resolved) continue;
      await this.db.transitionTask(ar.taskId, "running");
      await this.db.write({
        tenantId: ar.tenantId,
        eventType: "approval.expired",
        summary: ar.actionSummary ?? "",
        targetType: "approval",
        targetId: ar.id,
      });
    }
    return due.length;
  }

  private async resolve(
    approvalId: Id,
    to: "approved" | "rejected",
    byUserId: Id | undefined,
    eventType: string,
  ): Promise<ApprovalRequest> {
    const current = await this.db.getApprovalRequest(approvalId);
    if (!current) throw new Error(`approval not found: ${approvalId}`);
    assertApprovalTransition(current.status, to);
    const resolved = await this.db.resolveApprovalRequest(approvalId, to, byUserId ?? null);
    if (!resolved) throw new Error(`approval ${approvalId} was not pending`);
    await this.db.transitionTask(resolved.taskId, "running");
    await this.db.write({
      tenantId: resolved.tenantId,
      eventType,
      summary: resolved.actionSummary ?? "",
      targetType: "approval",
      targetId: approvalId,
      actorUserId: byUserId ?? null,
    });
    return resolved;
  }
}

export type ProposeResult =
  | { status: "executed"; result: ToolResult }
  | { status: "pending"; approvalId: Id }
  | { status: "denied"; reason: string };

/**
 * Propose a tool call: allow -> execute now; destructive -> create an approval
 * and pause; deny -> blocked.
 */
export async function proposeToolCall(
  gateway: ToolGateway,
  approvals: ApprovalService,
  toolName: string,
  input: ToolInput,
  ctx: { taskId: Id; tenantId: Id; agentId?: Id },
  meta: { actionSummary: string; requestedFromUserId?: Id; riskAxes?: RiskAxes; expiresInMs?: number },
): Promise<ProposeResult> {
  const decision = gateway.evaluate(toolName, input);
  if (decision.decision === "deny") {
    return { status: "denied", reason: decision.reason ?? "denied" };
  }
  if (decision.decision === "allow") {
    const result = await gateway.run(toolName, input, ctx);
    return { status: "executed", result };
  }
  // needs_approval
  const ar = await approvals.request({
    tenantId: ctx.tenantId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    requestedFromUserId: meta.requestedFromUserId,
    actionSummary: meta.actionSummary,
    riskAxes: meta.riskAxes,
    expiresInMs: meta.expiresInMs,
  });
  return { status: "pending", approvalId: ar.id };
}

/**
 * Execute a previously-approved tool call exactly once (write-action
 * idempotency: a retry/duplicate never double-executes).
 */
export async function executeApproved(
  gateway: ToolGateway,
  db: Database,
  toolName: string,
  input: ToolInput,
  ctx: { taskId: Id; tenantId: Id; agentId?: Id },
): Promise<{ executed: boolean; result?: ToolResult }> {
  const key = taskToolInputKey(ctx.taskId, toolName, input);
  return runOnce(db, key, () => gateway.run(toolName, input, ctx, { approved: true }));
}
