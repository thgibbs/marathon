import {
  assertEffectTransition,
  payloadHashOf,
  proposedEffectKey,
  type ApprovalRequest,
  type Id,
  type NewApprovalRequest,
  type NewAuditEvent,
  type NewProposedEffect,
  type ProposedEffect,
  type RiskAxes,
  type TaskStatus,
} from "@marathon/core";
import type { EffectExecutionResult, EffectExecutorRegistry } from "@marathon/tools";
import type { SecretStore } from "@marathon/config";

/**
 * The propose → review → execute workflow for real destructive actions
 * (design §7.9, §10.17; code-migration.md Track 9). This replaces the
 * deprecated `proposeToolCall`/`executeApproved` tool-replay model:
 *
 *  - the proposal is an immutable artifact — approval binds to its
 *    `payload_hash`, so a changed payload voids any approval;
 *  - the executor is a non-model, host-side function (see
 *    `EffectExecutorRegistry` in @marathon/tools) — the model never holds the
 *    credential that performs the destructive action;
 *  - execution is bounded to at most once by an atomic `approved → executing`
 *    claim.
 *
 * Marathon approval stays rare: normal code delivery is the GitHub-native
 * review flow (agent opens PR, human reviews, human merges).
 */

/** What the service needs from the database (`Database` satisfies this structurally). */
export interface ProposedEffectStore {
  createProposedEffect(input: NewProposedEffect): Promise<ProposedEffect>;
  getProposedEffect(id: Id): Promise<ProposedEffect | null>;
  /** proposed → approved|rejected|expired; null when the row was not `proposed` (lost race). */
  resolveProposedEffect(
    id: Id,
    to: "approved" | "rejected" | "expired",
    reviewerId?: Id | null,
  ): Promise<ProposedEffect | null>;
  /** Atomic approved → executing claim; null when not claimable (the at-most-once bound). */
  startProposedEffectExecution(id: Id): Promise<ProposedEffect | null>;
  finishProposedEffectExecution(id: Id, state: "executed" | "failed"): Promise<ProposedEffect>;
  createApprovalRequest(input: NewApprovalRequest): Promise<ApprovalRequest>;
  getPendingApprovalForEffect(effectId: Id): Promise<ApprovalRequest | null>;
  resolveApprovalRequestByEffect(
    effectId: Id,
    to: "approved" | "rejected" | "expired",
    byUserId?: Id | null,
  ): Promise<void>;
  transitionTask(taskId: Id, to: TaskStatus): Promise<unknown>;
  write(event: NewAuditEvent): Promise<unknown>;
}

export interface ProposeEffectInput {
  tenantId: Id;
  taskId: Id;
  agentId?: Id;
  requestedFromUserId?: Id;
  connectorId?: string;
  /** Typed per connector, e.g. `github.merge_pull_request`, `github.delete_branch`. */
  effectType: string;
  /** Destination / resource (e.g. { repo, number }). */
  target: Record<string, unknown>;
  /** The EXACT proposed mutation — approval binds to its hash. */
  payload: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  riskAxes?: RiskAxes;
  rollbackPlan?: string;
  expiresInMs?: number;
}

export class EffectApprovalError extends Error {
  constructor(
    public readonly code: "payload_changed" | "expired" | "not_pending" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "EffectApprovalError";
  }
}

export interface ProposeOutcome {
  effect: ProposedEffect;
  approval: ApprovalRequest;
  /** True when an identical proposal already existed (webhook/agent retry). */
  deduped: boolean;
}

export type ExecuteOutcome =
  | { executed: true; effect: ProposedEffect; result: EffectExecutionResult }
  | { executed: false; effect: ProposedEffect | null; reason: string };

export interface ProposedEffectServiceOptions {
  store: ProposedEffectStore;
  executors: EffectExecutorRegistry;
  secrets: SecretStore;
}

export class ProposedEffectService {
  constructor(private readonly opts: ProposedEffectServiceOptions) {}

  /**
   * Record the proposal + its approval request and pause the task
   * (waiting_for_approval). Idempotent on (task, effect type, payload hash):
   * a duplicate proposal converges on the existing artifact and approval.
   */
  async propose(input: ProposeEffectInput): Promise<ProposeOutcome> {
    const payloadHash = payloadHashOf(input.payload);
    const effect = await this.opts.store.createProposedEffect({
      tenantId: input.tenantId,
      taskId: input.taskId,
      connectorId: input.connectorId ?? null,
      effectType: input.effectType,
      target: input.target,
      payload: input.payload,
      payloadHash,
      provenance: input.provenance ?? null,
      riskAxes: input.riskAxes ?? null,
      rollbackPlan: input.rollbackPlan ?? null,
      approvalExpiresAt: input.expiresInMs ? new Date(Date.now() + input.expiresInMs) : null,
      idempotencyKey: proposedEffectKey(input.taskId, input.effectType, payloadHash),
    });

    const pending = await this.opts.store.getPendingApprovalForEffect(effect.id);
    if (pending) return { effect, approval: pending, deduped: true };

    const approval = await this.opts.store.createApprovalRequest({
      tenantId: input.tenantId,
      taskId: input.taskId,
      proposedEffectId: effect.id,
      requestedByAgentId: input.agentId ?? null,
      requestedFromUserId: input.requestedFromUserId ?? null,
      actionSummary: `${input.effectType} ${JSON.stringify(input.target)}`,
      riskAxes: input.riskAxes ?? null,
      expiresAt: effect.approvalExpiresAt,
    });
    await this.opts.store.transitionTask(input.taskId, "waiting_for_approval");
    await this.opts.store.write({
      tenantId: input.tenantId,
      eventType: "effect.proposed",
      summary: `${input.effectType} proposed (payload ${payloadHash.slice(0, 12)})`,
      targetType: "proposed_effect",
      targetId: effect.id,
      actorAgentId: input.agentId ?? null,
    });
    return { effect, approval, deduped: false };
  }

  /**
   * Approve the EXACT proposal: the caller must echo the payload hash it
   * reviewed. A hash mismatch means the proposal is not what was reviewed —
   * approval is void (§7.9).
   */
  async approve(effectId: Id, review: { payloadHash: string; byUserId?: Id }): Promise<ProposedEffect> {
    const effect = await this.requirePending(effectId);
    if (this.expireIfDue(effect)) {
      await this.expire(effectId);
      throw new EffectApprovalError("expired", `proposal ${effectId} expired before it was approved`);
    }
    if (review.payloadHash !== effect.payloadHash) {
      throw new EffectApprovalError(
        "payload_changed",
        `approval binds to the exact proposed payload — the reviewed hash does not match the proposal (approval is void)`,
      );
    }
    assertEffectTransition(effect.executionState, "approved");
    const resolved = await this.opts.store.resolveProposedEffect(effectId, "approved", review.byUserId ?? null);
    if (!resolved) throw new EffectApprovalError("not_pending", `proposal ${effectId} was already resolved`);
    await this.opts.store.resolveApprovalRequestByEffect(effectId, "approved", review.byUserId ?? null);
    await this.opts.store.transitionTask(effect.taskId, "running");
    await this.audit(effect, "effect.approved", review.byUserId);
    return resolved;
  }

  async reject(effectId: Id, byUserId?: Id): Promise<ProposedEffect> {
    const effect = await this.requirePending(effectId);
    assertEffectTransition(effect.executionState, "rejected");
    const resolved = await this.opts.store.resolveProposedEffect(effectId, "rejected", byUserId ?? null);
    if (!resolved) throw new EffectApprovalError("not_pending", `proposal ${effectId} was already resolved`);
    await this.opts.store.resolveApprovalRequestByEffect(effectId, "rejected", byUserId ?? null);
    await this.opts.store.transitionTask(effect.taskId, "running");
    await this.audit(effect, "effect.rejected", byUserId);
    return resolved;
  }

  /** Expire a stale pending proposal and resume its task. */
  async expire(effectId: Id): Promise<ProposedEffect | null> {
    const effect = await this.opts.store.getProposedEffect(effectId);
    if (!effect || effect.executionState !== "proposed") return null;
    const resolved = await this.opts.store.resolveProposedEffect(effectId, "expired");
    if (!resolved) return null;
    await this.opts.store.resolveApprovalRequestByEffect(effectId, "expired");
    await this.opts.store.transitionTask(effect.taskId, "running");
    await this.audit(effect, "effect.expired");
    return resolved;
  }

  /**
   * Perform an approved effect through its registered non-model executor,
   * at most once: the approved → executing claim is atomic, so a concurrent
   * or repeated execute is a no-op.
   */
  async execute(effectId: Id): Promise<ExecuteOutcome> {
    const claimed = await this.opts.store.startProposedEffectExecution(effectId);
    if (!claimed) {
      const current = await this.opts.store.getProposedEffect(effectId);
      return {
        executed: false,
        effect: current,
        reason: current ? `proposal is ${current.executionState}, not approved` : "proposal not found",
      };
    }
    const executor = this.opts.executors.get(claimed.effectType);
    if (!executor) {
      await this.opts.store.finishProposedEffectExecution(effectId, "failed");
      await this.audit(claimed, "effect.failed");
      throw new Error(`no executor registered for effect type: ${claimed.effectType}`);
    }
    try {
      const result = await executor(claimed, { secrets: this.opts.secrets });
      const effect = await this.opts.store.finishProposedEffectExecution(effectId, "executed");
      await this.audit(claimed, "effect.executed");
      return { executed: true, effect, result };
    } catch (err) {
      await this.opts.store.finishProposedEffectExecution(effectId, "failed");
      await this.audit(claimed, "effect.failed");
      throw err;
    }
  }

  private async requirePending(effectId: Id): Promise<ProposedEffect> {
    const effect = await this.opts.store.getProposedEffect(effectId);
    if (!effect) throw new EffectApprovalError("not_found", `proposal not found: ${effectId}`);
    return effect;
  }

  private expireIfDue(effect: ProposedEffect, now = Date.now()): boolean {
    return effect.approvalExpiresAt !== null && effect.approvalExpiresAt.getTime() <= now;
  }

  private async audit(effect: ProposedEffect, eventType: string, byUserId?: Id): Promise<void> {
    await this.opts.store.write({
      tenantId: effect.tenantId,
      eventType,
      summary: `${effect.effectType} ${JSON.stringify(effect.target)}`,
      targetType: "proposed_effect",
      targetId: effect.id,
      actorUserId: byUserId ?? null,
    });
  }
}

/** In-memory `ProposedEffectStore` for tests and demos (mirrors the SQL semantics). */
export class InMemoryProposedEffectStore implements ProposedEffectStore {
  public readonly effects = new Map<Id, ProposedEffect>();
  public readonly approvals = new Map<Id, ApprovalRequest>();
  public readonly taskTransitions: Array<{ taskId: Id; to: TaskStatus }> = [];
  public readonly audits: NewAuditEvent[] = [];
  private seq = 1;

  async createProposedEffect(input: NewProposedEffect): Promise<ProposedEffect> {
    for (const e of this.effects.values()) {
      if (e.tenantId === input.tenantId && e.idempotencyKey === input.idempotencyKey) return e;
    }
    const now = new Date();
    const effect: ProposedEffect = {
      id: `pe-${this.seq++}`,
      tenantId: input.tenantId,
      taskId: input.taskId,
      connectorId: input.connectorId ?? null,
      effectType: input.effectType,
      target: input.target,
      payload: input.payload,
      payloadHash: input.payloadHash,
      proposalVersion: 1,
      provenance: input.provenance ?? null,
      riskAxes: input.riskAxes ?? null,
      rollbackPlan: input.rollbackPlan ?? null,
      reviewerId: null,
      reviewerAuthority: null,
      approvalExpiresAt: input.approvalExpiresAt ?? null,
      idempotencyKey: input.idempotencyKey,
      executionState: "proposed",
      createdAt: now,
      resolvedAt: null,
      executedAt: null,
    };
    this.effects.set(effect.id, effect);
    return effect;
  }

  async getProposedEffect(id: Id): Promise<ProposedEffect | null> {
    return this.effects.get(id) ?? null;
  }

  async resolveProposedEffect(
    id: Id,
    to: "approved" | "rejected" | "expired",
    reviewerId?: Id | null,
  ): Promise<ProposedEffect | null> {
    const e = this.effects.get(id);
    if (!e || e.executionState !== "proposed") return null;
    const updated: ProposedEffect = {
      ...e,
      executionState: to,
      resolvedAt: new Date(),
      reviewerId: reviewerId ?? e.reviewerId,
    };
    this.effects.set(id, updated);
    return updated;
  }

  async startProposedEffectExecution(id: Id): Promise<ProposedEffect | null> {
    const e = this.effects.get(id);
    if (!e || e.executionState !== "approved") return null;
    const updated: ProposedEffect = { ...e, executionState: "executing" };
    this.effects.set(id, updated);
    return updated;
  }

  async finishProposedEffectExecution(id: Id, state: "executed" | "failed"): Promise<ProposedEffect> {
    const e = this.effects.get(id);
    if (!e || e.executionState !== "executing") throw new Error(`proposed_effect ${id} is not executing`);
    const updated: ProposedEffect = { ...e, executionState: state, executedAt: new Date() };
    this.effects.set(id, updated);
    return updated;
  }

  async createApprovalRequest(input: NewApprovalRequest): Promise<ApprovalRequest> {
    const now = new Date();
    const ar: ApprovalRequest = {
      id: `ar-${this.seq++}`,
      tenantId: input.tenantId,
      taskId: input.taskId,
      toolInvocationId: input.toolInvocationId ?? null,
      proposedEffectId: input.proposedEffectId ?? null,
      requestedByAgentId: input.requestedByAgentId ?? null,
      requestedFromUserId: input.requestedFromUserId ?? null,
      status: "pending",
      actionSummary: input.actionSummary ?? null,
      riskAxes: input.riskAxes ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      resolvedAt: null,
      resolvedByUserId: null,
    };
    this.approvals.set(ar.id, ar);
    return ar;
  }

  async getPendingApprovalForEffect(effectId: Id): Promise<ApprovalRequest | null> {
    for (const a of this.approvals.values()) {
      if (a.proposedEffectId === effectId && a.status === "pending") return a;
    }
    return null;
  }

  async resolveApprovalRequestByEffect(
    effectId: Id,
    to: "approved" | "rejected" | "expired",
    byUserId?: Id | null,
  ): Promise<void> {
    for (const [id, a] of this.approvals) {
      if (a.proposedEffectId === effectId && a.status === "pending") {
        this.approvals.set(id, { ...a, status: to, resolvedAt: new Date(), resolvedByUserId: byUserId ?? null });
      }
    }
  }

  async transitionTask(taskId: Id, to: TaskStatus): Promise<unknown> {
    this.taskTransitions.push({ taskId, to });
    return undefined;
  }

  async write(event: NewAuditEvent): Promise<unknown> {
    this.audits.push(event);
    return undefined;
  }
}
