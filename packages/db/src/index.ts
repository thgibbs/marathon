import { Pool } from "pg";
import type { ToolRecorder } from "@marathon/tools";
import {
  assertTransition,
  isTerminal,
  type ApprovalRequest,
  type ApprovalStatus,
  type AuditWriter,
  type AuditEvent,
  type Agent,
  type AgentVersion,
  type Checkpoint,
  type CodeChange,
  type CodeChangeState,
  type DeliveryTarget,
  type DocumentArtifact,
  type Id,
  type NewDocumentArtifact,
  type IdempotencyStore,
  type NewApprovalRequest,
  type NewAuditEvent,
  type NewCodeChange,
  type NewModelInvocation,
  type NewProposedEffect,
  type ProposedEffect,
  type RiskAxes,
  type Role,
  type SurfaceType,
  type Task,
  type TaskStatus,
  type Tenant,
  type User,
  type UserIdentity,
  type VerificationResult,
} from "@marathon/core";

export { migrate } from "./migrate";

/** Timestamp column to stamp when a task enters a given status. */
const STATUS_TIMESTAMP: Partial<Record<TaskStatus, string>> = {
  running: "started_at",
  completed: "completed_at",
  failed: "failed_at",
  cancelled: "cancelled_at",
};

/**
 * Thin typed data-access layer over Postgres. M0 covers the entities the
 * foundations demo exercises plus the audit writer; more repositories land
 * with later milestones.
 */
export class Database implements AuditWriter, IdempotencyStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createTenant(input: { name: string }): Promise<Tenant> {
    const { rows } = await this.pool.query(
      `insert into tenant(name) values ($1) returning *`,
      [input.name],
    );
    return rowToTenant(rows[0]);
  }

  async createUser(input: {
    tenantId: Id;
    displayName?: string;
    email?: string;
    role?: Role;
  }): Promise<User> {
    const { rows } = await this.pool.query(
      `insert into app_user(tenant_id, display_name, email, role)
       values ($1, $2, $3, $4) returning *`,
      [input.tenantId, input.displayName ?? null, input.email ?? null, input.role ?? "user"],
    );
    return rowToUser(rows[0]);
  }

  async createAgent(input: {
    tenantId: Id;
    name: string;
    displayName?: string;
    ownerUserId?: Id;
  }): Promise<Agent> {
    const { rows } = await this.pool.query(
      `insert into agent(tenant_id, name, display_name, owner_user_id)
       values ($1, $2, $3, $4) returning *`,
      [input.tenantId, input.name, input.displayName ?? null, input.ownerUserId ?? null],
    );
    return rowToAgent(rows[0]);
  }

  /** Find a tenant by its Slack team id (stored in settings), creating it if new. */
  async findOrCreateTenantBySlackTeam(teamId: string, name: string): Promise<Tenant> {
    const existing = await this.pool.query(
      `select * from tenant where settings->>'slack_team_id' = $1 limit 1`,
      [teamId],
    );
    if (existing.rows[0]) return rowToTenant(existing.rows[0]);
    const { rows } = await this.pool.query(
      `insert into tenant(name, settings) values ($1, $2) returning *`,
      [name, JSON.stringify({ slack_team_id: teamId })],
    );
    return rowToTenant(rows[0]);
  }

  /** Find a tenant by GitHub owner (stored in settings), creating it if new. */
  async findOrCreateTenantByGithubOwner(owner: string, name?: string): Promise<Tenant> {
    const existing = await this.pool.query(
      `select * from tenant where settings->>'github_owner' = $1 limit 1`,
      [owner],
    );
    if (existing.rows[0]) return rowToTenant(existing.rows[0]);
    const { rows } = await this.pool.query(
      `insert into tenant(name, settings) values ($1, $2) returning *`,
      [name ?? owner, JSON.stringify({ github_owner: owner })],
    );
    return rowToTenant(rows[0]);
  }

  async findOrCreateAgent(tenantId: Id, name: string): Promise<Agent> {
    const existing = await this.pool.query(`select * from agent where tenant_id = $1 and name = $2`, [
      tenantId,
      name,
    ]);
    if (existing.rows[0]) return rowToAgent(existing.rows[0]);
    return this.createAgent({ tenantId, name });
  }

  async createAgentVersion(input: {
    agentId: Id;
    versionNumber: number;
    instructions?: string;
  }): Promise<AgentVersion> {
    const { rows } = await this.pool.query(
      `insert into agent_version(agent_id, version_number, instructions)
       values ($1, $2, $3) returning *`,
      [input.agentId, input.versionNumber, input.instructions ?? null],
    );
    return rowToAgentVersion(rows[0]);
  }

  /** Latest agent version (highest version_number) for loading instructions/persona. */
  async getLatestAgentVersion(agentId: Id): Promise<AgentVersion | null> {
    const { rows } = await this.pool.query(
      `select * from agent_version where agent_id = $1 order by version_number desc limit 1`,
      [agentId],
    );
    return rows[0] ? rowToAgentVersion(rows[0]) : null;
  }

  async createTask(input: {
    tenantId: Id;
    agentId?: Id;
    agentVersionId?: Id;
    invokingUserId?: Id;
    sourceTaskId?: Id;
    sourceType: SurfaceType;
    sourceRef?: Record<string, unknown>;
    /** Where progress/results land (design §10.8); defaults to [the source]. */
    deliveryTargets?: DeliveryTarget[];
    inputText?: string;
  }): Promise<Task> {
    const sourceRef = input.sourceRef ?? {};
    const deliveryTargets =
      input.deliveryTargets ?? [{ surfaceType: input.sourceType, ref: sourceRef }];
    const { rows } = await this.pool.query(
      `insert into task(tenant_id, agent_id, agent_version_id, invoking_user_id, source_task_id,
                        source_type, source_ref, delivery_targets, input_text)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.tenantId,
        input.agentId ?? null,
        input.agentVersionId ?? null,
        input.invokingUserId ?? null,
        input.sourceTaskId ?? null,
        input.sourceType,
        JSON.stringify(sourceRef),
        JSON.stringify(deliveryTargets),
        input.inputText ?? null,
      ],
    );
    return rowToTask(rows[0]);
  }

  /** Replace a task's delivery targets (e.g. + the doc PR once it exists — K2). */
  async updateTaskDeliveryTargets(id: Id, targets: DeliveryTarget[]): Promise<void> {
    await this.pool.query(`update task set delivery_targets = $2 where id = $1`, [
      id,
      JSON.stringify(targets),
    ]);
  }

  /** Latest task chained off a source task (K2: doc task → implementation task). */
  async findTaskBySourceTask(sourceTaskId: Id): Promise<Task | null> {
    const { rows } = await this.pool.query(
      `select * from task where source_task_id = $1 order by created_at desc limit 1`,
      [sourceTaskId],
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async countTasksBySourceTask(sourceTaskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from task where source_task_id = $1`,
      [sourceTaskId],
    );
    return rows[0].n as number;
  }

  async getTask(id: Id): Promise<Task | null> {
    const { rows } = await this.pool.query(`select * from task where id = $1`, [id]);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  /**
   * Move a task to a new status, enforcing the state machine. Stamps the
   * matching timestamp column. Throws InvalidTransitionError on a bad move.
   */
  async transitionTask(id: Id, to: TaskStatus): Promise<Task> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query(
        `select status from task where id = $1 for update`,
        [id],
      );
      if (!current.rows[0]) throw new Error(`task not found: ${id}`);
      const from = current.rows[0].status as TaskStatus;
      assertTransition(from, to);

      const stampCol = STATUS_TIMESTAMP[to];
      const setStamp = stampCol ? `, ${stampCol} = now()` : "";
      const { rows } = await client.query(
        `update task set status = $2${setStamp} where id = $1 returning *`,
        [id, to],
      );
      await client.query("commit");
      return rowToTask(rows[0]);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  /** AuditWriter implementation backed by Postgres. */
  async write(event: NewAuditEvent): Promise<AuditEvent> {
    const { rows } = await this.pool.query(
      `insert into audit_event(tenant_id, actor_user_id, actor_agent_id, event_type,
                               target_type, target_id, summary, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        event.tenantId,
        event.actorUserId ?? null,
        event.actorAgentId ?? null,
        event.eventType,
        event.targetType ?? null,
        event.targetId ?? null,
        event.summary ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ],
    );
    return rowToAuditEvent(rows[0]);
  }

  async countAuditEvents(tenantId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from audit_event where tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  }

  /**
   * Record one completed step's effect and the new checkpoint atomically, so a
   * crash leaves the task either fully before or fully after the step (the basis
   * for exactly-once resume).
   */
  async completeStep(
    taskId: Id,
    stepType: string,
    checkpoint: Checkpoint,
    modelInvocations: Array<Omit<NewModelInvocation, "taskId">> = [],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const stepRes = await client.query(
        `insert into task_step(task_id, step_type, status, started_at, completed_at)
         values ($1, $2, 'completed', now(), now())
         returning id`,
        [taskId, stepType],
      );
      const stepId = stepRes.rows[0].id as string;
      await client.query(`update task set checkpoint = $2 where id = $1`, [
        taskId,
        JSON.stringify(checkpoint),
      ]);
      for (const mi of modelInvocations) {
        await client.query(
          `insert into model_invocation(task_id, task_step_id, provider, model, prompt_version,
                                        input_tokens, output_tokens, cost_usd, latency_ms, status, error)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            taskId,
            mi.taskStepId ?? stepId,
            mi.provider,
            mi.model,
            mi.promptVersion ?? null,
            mi.inputTokens ?? null,
            mi.outputTokens ?? null,
            mi.costUsd ?? null,
            mi.latencyMs ?? null,
            mi.status ?? null,
            mi.error ?? null,
          ],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async countTaskSteps(taskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from task_step where task_id = $1`,
      [taskId],
    );
    return rows[0].n as number;
  }

  async countModelInvocations(taskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from model_invocation where task_id = $1`,
      [taskId],
    );
    return rows[0].n as number;
  }

  async recordToolInvocation(rec: {
    taskId: Id;
    toolId: string;
    status: string;
    riskAxes?: RiskAxes | null;
    inputSummary?: string | null;
    outputSummary?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `insert into tool_invocation(task_id, tool_id, status, risk_axes, input_summary, output_summary, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        rec.taskId,
        rec.toolId,
        rec.status,
        rec.riskAxes ? JSON.stringify(rec.riskAxes) : null,
        rec.inputSummary ?? null,
        rec.outputSummary ?? null,
        rec.error ?? null,
      ],
    );
  }

  async countToolInvocations(taskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from tool_invocation where task_id = $1`,
      [taskId],
    );
    return rows[0].n as number;
  }

  /** All recorded tool-invocation summaries for a task (for trace assertions). */
  async toolInvocationSummaries(taskId: Id): Promise<string[]> {
    const { rows } = await this.pool.query(
      `select coalesce(input_summary, '') || ' ' || coalesce(output_summary, '') || ' ' || coalesce(error, '') as s
       from tool_invocation where task_id = $1`,
      [taskId],
    );
    return rows.map((r) => r.s as string);
  }

  async countAuditByType(tenantId: Id, eventType: string): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from audit_event where tenant_id = $1 and event_type = $2`,
      [tenantId, eventType],
    );
    return rows[0].n as number;
  }

  // --- approvals ---

  async createApprovalRequest(input: NewApprovalRequest): Promise<ApprovalRequest> {
    const { rows } = await this.pool.query(
      `insert into approval_request(tenant_id, task_id, tool_invocation_id, proposed_effect_id,
                                    requested_by_agent_id, requested_from_user_id, action_summary,
                                    risk_axes, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.tenantId,
        input.taskId,
        input.toolInvocationId ?? null,
        input.proposedEffectId ?? null,
        input.requestedByAgentId ?? null,
        input.requestedFromUserId ?? null,
        input.actionSummary ?? null,
        input.riskAxes ? JSON.stringify(input.riskAxes) : null,
        input.expiresAt ?? null,
      ],
    );
    return rowToApproval(rows[0]);
  }

  async getApprovalRequest(id: Id): Promise<ApprovalRequest | null> {
    const { rows } = await this.pool.query(`select * from approval_request where id = $1`, [id]);
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  /** Resolve a pending approval. Returns null if it was not pending (race-safe). */
  async resolveApprovalRequest(
    id: Id,
    status: Exclude<ApprovalStatus, "pending">,
    byUserId?: Id | null,
  ): Promise<ApprovalRequest | null> {
    const { rows } = await this.pool.query(
      `update approval_request
         set status = $2, resolved_at = now(), resolved_by_user_id = $3
       where id = $1 and status = 'pending'
       returning *`,
      [id, status, byUserId ?? null],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  async listExpiredApprovals(now: Date): Promise<ApprovalRequest[]> {
    const { rows } = await this.pool.query(
      `select * from approval_request where status = 'pending' and expires_at is not null and expires_at <= $1`,
      [now],
    );
    return rows.map(rowToApproval);
  }

  async countApprovalsByStatus(tenantId: Id, status: ApprovalStatus): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from approval_request where tenant_id = $1 and status = $2`,
      [tenantId, status],
    );
    return rows[0].n as number;
  }

  // --- proposed effects (design §10.17; executor lands with M10) ---

  /**
   * Record a proposal. Idempotent on (tenant_id, idempotency_key): a duplicate
   * proposal returns the existing row unchanged (the proposal is immutable
   * once review starts — §7.9).
   */
  async createProposedEffect(input: NewProposedEffect): Promise<ProposedEffect> {
    const { rows } = await this.pool.query(
      `insert into proposed_effect(tenant_id, task_id, connector_id, effect_type, target, payload,
                                   payload_hash, provenance, risk_axes, rollback_plan,
                                   approval_expires_at, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (tenant_id, idempotency_key) do nothing
       returning *`,
      [
        input.tenantId,
        input.taskId,
        input.connectorId ?? null,
        input.effectType,
        JSON.stringify(input.target),
        JSON.stringify(input.payload),
        input.payloadHash,
        input.provenance ? JSON.stringify(input.provenance) : null,
        input.riskAxes ? JSON.stringify(input.riskAxes) : null,
        input.rollbackPlan ?? null,
        input.approvalExpiresAt ?? null,
        input.idempotencyKey,
      ],
    );
    if (rows[0]) return rowToProposedEffect(rows[0]);
    const existing = await this.pool.query(
      `select * from proposed_effect where tenant_id = $1 and idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    return rowToProposedEffect(existing.rows[0]);
  }

  async getProposedEffect(id: Id): Promise<ProposedEffect | null> {
    const { rows } = await this.pool.query(`select * from proposed_effect where id = $1`, [id]);
    return rows[0] ? rowToProposedEffect(rows[0]) : null;
  }

  /**
   * proposed → approved | rejected | expired (design §7.9, Track 9). The state
   * guard is in the WHERE clause, so a lost race returns null instead of
   * clobbering a resolution.
   */
  async resolveProposedEffect(
    id: Id,
    to: "approved" | "rejected" | "expired",
    reviewerId?: Id | null,
  ): Promise<ProposedEffect | null> {
    const { rows } = await this.pool.query(
      `update proposed_effect
         set execution_state = $2, resolved_at = now(), reviewer_id = coalesce($3, reviewer_id)
       where id = $1 and execution_state = 'proposed' returning *`,
      [id, to, reviewerId ?? null],
    );
    return rows[0] ? rowToProposedEffect(rows[0]) : null;
  }

  /**
   * Atomic approved → executing claim: the at-most-once bound for the
   * non-model executor. Null when the effect was not claimable.
   */
  async startProposedEffectExecution(id: Id): Promise<ProposedEffect | null> {
    const { rows } = await this.pool.query(
      `update proposed_effect set execution_state = 'executing'
       where id = $1 and execution_state = 'approved' returning *`,
      [id],
    );
    return rows[0] ? rowToProposedEffect(rows[0]) : null;
  }

  async finishProposedEffectExecution(id: Id, state: "executed" | "failed"): Promise<ProposedEffect> {
    const { rows } = await this.pool.query(
      `update proposed_effect set execution_state = $2, executed_at = now()
       where id = $1 and execution_state = 'executing' returning *`,
      [id, state],
    );
    if (!rows[0]) throw new Error(`proposed_effect ${id} is not executing`);
    return rowToProposedEffect(rows[0]);
  }

  async getPendingApprovalForEffect(effectId: Id): Promise<ApprovalRequest | null> {
    const { rows } = await this.pool.query(
      `select * from approval_request where proposed_effect_id = $1 and status = 'pending' limit 1`,
      [effectId],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  /** Resolve the pending approval bound to an effect (approve/reject/expire together). */
  async resolveApprovalRequestByEffect(
    effectId: Id,
    to: "approved" | "rejected" | "expired",
    byUserId?: Id | null,
  ): Promise<void> {
    await this.pool.query(
      `update approval_request
         set status = $2, resolved_at = now(), resolved_by_user_id = $3
       where proposed_effect_id = $1 and status = 'pending'`,
      [effectId, to, byUserId ?? null],
    );
  }

  // --- IdempotencyStore ---

  async claim(key: string): Promise<boolean> {
    const res = await this.pool.query(
      `insert into idempotency_key(key) values ($1) on conflict (key) do nothing`,
      [key],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async release(key: string): Promise<void> {
    await this.pool.query(`delete from idempotency_key where key = $1`, [key]);
  }

  // --- surface identity & feedback (M4) ---

  /** Find the user behind a surface identity, creating the user + identity if new. */
  async findOrCreateUserByIdentity(
    tenantId: Id,
    surfaceType: SurfaceType,
    externalId: string,
    displayName?: string,
  ): Promise<User> {
    const existing = await this.pool.query(
      `select u.* from app_user u
         join user_identity i on i.user_id = u.id
       where i.surface_type = $1 and i.external_id = $2 and u.tenant_id = $3`,
      [surfaceType, externalId, tenantId],
    );
    if (existing.rows[0]) return rowToUser(existing.rows[0]);

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const u = await client.query(
        `insert into app_user(tenant_id, display_name, role) values ($1, $2, 'user') returning *`,
        [tenantId, displayName ?? null],
      );
      await client.query(
        `insert into user_identity(user_id, tenant_id, surface_type, external_id) values ($1, $2, $3, $4)`,
        [u.rows[0].id, tenantId, surfaceType, externalId],
      );
      await client.query("commit");
      return rowToUser(u.rows[0]);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Look up a surface identity within a tenant (design §10.2). */
  async findUserIdentity(
    tenantId: Id,
    surfaceType: SurfaceType,
    externalId: string,
  ): Promise<UserIdentity | null> {
    const { rows } = await this.pool.query(
      `select * from user_identity
       where tenant_id = $1 and surface_type = $2 and external_id = $3`,
      [tenantId, surfaceType, externalId],
    );
    return rows[0] ? rowToUserIdentity(rows[0]) : null;
  }

  async recordFeedback(input: {
    tenantId: Id;
    taskId?: Id;
    agentId?: Id;
    userId?: Id;
    feedbackType: "thumbs_up" | "thumbs_down" | "free_text";
    comment?: string;
  }): Promise<void> {
    await this.pool.query(
      `insert into feedback(tenant_id, task_id, agent_id, user_id, feedback_type, comment)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.tenantId,
        input.taskId ?? null,
        input.agentId ?? null,
        input.userId ?? null,
        input.feedbackType,
        input.comment ?? null,
      ],
    );
  }

  async countFeedback(tenantId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from feedback where tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  }

  async countTasks(tenantId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from task where tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  }

  // --- document artifacts (M6) ---

  async recordDocumentArtifact(input: NewDocumentArtifact): Promise<DocumentArtifact> {
    const { rows } = await this.pool.query(
      `insert into document_artifact(tenant_id, surface_type, location, title, role,
                                     owning_task_id, owning_agent_id, last_revision_seen)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.tenantId,
        input.surfaceType ?? "github",
        JSON.stringify(input.location),
        input.title ?? null,
        input.role ?? null,
        input.owningTaskId ?? null,
        input.owningAgentId ?? null,
        input.lastRevisionSeen ?? null,
      ],
    );
    return rowToDocumentArtifact(rows[0]);
  }

  /** Find a produced document by its repo + PR number (for merge handling). */
  async findDocumentArtifactByPr(tenantId: Id, repo: string, prNumber: number): Promise<DocumentArtifact | null> {
    const { rows } = await this.pool.query(
      `select * from document_artifact
       where tenant_id = $1 and location->>'repo' = $2 and (location->>'prNumber')::int = $3
       order by created_at desc limit 1`,
      [tenantId, repo, prNumber],
    );
    return rows[0] ? rowToDocumentArtifact(rows[0]) : null;
  }

  /** Watched documents in a repo (for reacting to pushes — M7 #8). */
  async listWatchedArtifacts(tenantId: Id, repo: string): Promise<DocumentArtifact[]> {
    const { rows } = await this.pool.query(
      `select * from document_artifact
       where tenant_id = $1 and role = 'watched' and location->>'repo' = $2`,
      [tenantId, repo],
    );
    return rows.map(rowToDocumentArtifact);
  }

  async updateDocumentArtifactRevision(id: Id, revision: string): Promise<void> {
    await this.pool.query(
      `update document_artifact set last_revision_seen = $2, updated_at = now() where id = $1`,
      [id, revision],
    );
  }

  async countDocumentArtifacts(tenantId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from document_artifact where tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  }

  // --- code changes (K1, design §10.19) ---

  /** One CodeChange per implementation task; a re-create for the same task returns the existing row. */
  async createCodeChange(input: NewCodeChange): Promise<CodeChange> {
    const { rows } = await this.pool.query(
      `insert into code_change(tenant_id, task_id, repo, plan_ref, base_sha, branch)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (task_id) do update set updated_at = now()
       returning *`,
      [
        input.tenantId,
        input.taskId,
        input.repo,
        JSON.stringify(input.planRef),
        input.baseSha,
        input.branch,
      ],
    );
    return rowToCodeChange(rows[0]);
  }

  async getCodeChangeByTask(taskId: Id): Promise<CodeChange | null> {
    const { rows } = await this.pool.query(`select * from code_change where task_id = $1`, [taskId]);
    return rows[0] ? rowToCodeChange(rows[0]) : null;
  }

  /** Record the outcome of a submit (§29.4 step 6-7): tree hash, PR, state, verification. */
  async updateCodeChangeSubmission(
    taskId: Id,
    patch: {
      treeHash: string;
      prNumber: number;
      prUrl: string;
      state: CodeChangeState;
      verification: VerificationResult[];
    },
  ): Promise<CodeChange> {
    const { rows } = await this.pool.query(
      `update code_change
         set tree_hash = $2, pr_number = $3, pr_url = $4, state = $5, verification = $6, updated_at = now()
       where task_id = $1 returning *`,
      [taskId, patch.treeHash, patch.prNumber, patch.prUrl, patch.state, JSON.stringify(patch.verification)],
    );
    if (!rows[0]) throw new Error(`code_change not found for task: ${taskId}`);
    return rowToCodeChange(rows[0]);
  }

  /**
   * Record an agent-driven delivery (`delivery.report_pr`, Track 7): the agent
   * pushed and opened the PR itself, so there is no gateway tree hash — the
   * record binds the task to the PR (branch comes from GitHub, not the model).
   */
  async recordCodeChangeReport(
    taskId: Id,
    patch: {
      prNumber: number;
      prUrl: string;
      branch: string;
      state: CodeChangeState;
      verification: VerificationResult[];
    },
  ): Promise<CodeChange> {
    const { rows } = await this.pool.query(
      `update code_change
         set pr_number = $2, pr_url = $3, branch = $4, state = $5, verification = $6, updated_at = now()
       where task_id = $1 returning *`,
      [taskId, patch.prNumber, patch.prUrl, patch.branch, patch.state, JSON.stringify(patch.verification)],
    );
    if (!rows[0]) throw new Error(`code_change not found for task: ${taskId}`);
    return rowToCodeChange(rows[0]);
  }

  async sumModelCostUsd(taskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select coalesce(sum(cost_usd), 0)::float8 as total from model_invocation where task_id = $1`,
      [taskId],
    );
    return rows[0].total as number;
  }

  // --- M8 inspectability / cost / metrics reads ---

  async getTaskSteps(taskId: Id): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(`select * from task_step where task_id = $1 order by created_at asc`, [taskId]);
    return rows;
  }

  async getModelInvocations(taskId: Id): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(`select * from model_invocation where task_id = $1 order by created_at asc`, [taskId]);
    return rows;
  }

  async getToolInvocations(taskId: Id): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(`select * from tool_invocation where task_id = $1 order by created_at asc`, [taskId]);
    return rows;
  }

  async listApprovalsForTask(taskId: Id): Promise<ApprovalRequest[]> {
    const { rows } = await this.pool.query(`select * from approval_request where task_id = $1 order by created_at asc`, [taskId]);
    return rows.map(rowToApproval);
  }

  async getTaskAuditEvents(taskId: Id): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      `select * from audit_event where target_type = 'task' and target_id = $1 order by created_at asc`,
      [taskId],
    );
    return rows;
  }

  /** Total model spend for a tenant (optionally one agent). */
  async sumModelCostUsdByTenant(tenantId: Id, agentId?: Id): Promise<number> {
    const params: unknown[] = [tenantId];
    let clause = "t.tenant_id = $1";
    if (agentId) {
      params.push(agentId);
      clause += ` and t.agent_id = $2`;
    }
    const { rows } = await this.pool.query(
      `select coalesce(sum(mi.cost_usd), 0)::float8 as total
       from model_invocation mi join task t on t.id = mi.task_id
       where ${clause}`,
      params,
    );
    return rows[0].total as number;
  }

  /** Cost rollup grouped by model | agent | task for a tenant. */
  async costRollup(tenantId: Id, by: "model" | "agent" | "task"): Promise<Array<{ key: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>> {
    const keyExpr = by === "model" ? `mi.provider || ':' || mi.model` : by === "agent" ? `coalesce(t.agent_id::text, 'none')` : `mi.task_id::text`;
    const { rows } = await this.pool.query(
      `select ${keyExpr} as key,
              coalesce(sum(mi.cost_usd),0)::float8 as cost_usd,
              count(*)::int as calls,
              coalesce(sum(mi.input_tokens),0)::int as input_tokens,
              coalesce(sum(mi.output_tokens),0)::int as output_tokens
       from model_invocation mi join task t on t.id = mi.task_id
       where t.tenant_id = $1
       group by key order by cost_usd desc`,
      [tenantId],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ key: r.key, costUsd: r.cost_usd, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens }));
  }

  async countTasksByStatus(tenantId: Id): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(`select status, count(*)::int as n from task where tenant_id = $1 group by status`, [tenantId]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
  }

  /** Job counts by status, scoped to a tenant (via the owning task). */
  async countJobsByStatus(tenantId: Id): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      `select j.status, count(*)::int as n
       from job j join task t on t.id = j.task_id
       where t.tenant_id = $1 group by j.status`,
      [tenantId],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
  }

  /** Error rate (errored/total) for tool or model invocations in a tenant. */
  async invocationErrorRate(tenantId: Id, kind: "tool" | "model"): Promise<{ total: number; errored: number; rate: number }> {
    const table = kind === "tool" ? "tool_invocation" : "model_invocation";
    const { rows } = await this.pool.query(
      `select count(*)::int as total, count(*) filter (where x.status = 'error')::int as errored
       from ${table} x join task t on t.id = x.task_id where t.tenant_id = $1`,
      [tenantId],
    );
    const total = rows[0].total as number;
    const errored = rows[0].errored as number;
    return { total, errored, rate: total ? errored / total : 0 };
  }
}

/**
 * A {@link ToolGateway} recorder that persists tool invocations + audit events to
 * the database. DRYs the recorder wiring shared by the apps and demos.
 */
export function dbToolRecorder(db: Database): ToolRecorder {
  return {
    onInvocation: (r) =>
      db.recordToolInvocation({
        taskId: r.taskId,
        toolId: r.toolName,
        status: r.status,
        riskAxes: r.riskAxes,
        inputSummary: r.inputSummary,
        outputSummary: r.outputSummary,
        error: r.error,
      }),
    onAudit: (e) =>
      db.write({
        tenantId: e.tenantId,
        eventType: e.eventType,
        summary: e.summary,
        targetType: e.targetType,
        targetId: e.targetId,
        actorAgentId: e.actorAgentId,
      }),
  };
}

// --- row mappers (snake_case → camelCase) ---

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToTenant(r: any): Tenant {
  return {
    id: r.id,
    name: r.name,
    settings: r.settings,
    retentionPolicy: r.retention_policy,
    defaultModelPolicy: r.default_model_policy,
    budgetPolicy: r.budget_policy,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToUser(r: any): User {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    displayName: r.display_name,
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    ownerUserId: r.owner_user_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAgentVersion(r: any): AgentVersion {
  return {
    id: r.id,
    agentId: r.agent_id,
    versionNumber: r.version_number,
    status: r.status,
    instructions: r.instructions,
    modelPolicy: r.model_policy,
    toolPolicy: r.tool_policy,
    memoryPolicy: r.memory_policy,
    approvalPolicy: r.approval_policy,
    createdBy: r.created_by,
    createdAt: r.created_at,
    publishedAt: r.published_at,
  };
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    agentVersionId: r.agent_version_id,
    invokingUserId: r.invoking_user_id,
    sourceTaskId: r.source_task_id ?? null,
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    deliveryTargets: r.delivery_targets ?? null,
    status: r.status,
    inputText: r.input_text,
    summary: r.summary,
    checkpoint: r.checkpoint ?? null,
    costUsd: Number(r.cost_usd),
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    failedAt: r.failed_at,
    cancelledAt: r.cancelled_at,
  };
}

function rowToDocumentArtifact(r: any): DocumentArtifact {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    surfaceType: r.surface_type,
    location: r.location ?? {},
    title: r.title,
    role: r.role,
    owningTaskId: r.owning_task_id,
    owningAgentId: r.owning_agent_id,
    lastRevisionSeen: r.last_revision_seen,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCodeChange(r: any): CodeChange {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    repo: r.repo,
    planRef: r.plan_ref,
    baseSha: r.base_sha,
    branch: r.branch,
    treeHash: r.tree_hash,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    state: r.state,
    verification: r.verification ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToApproval(r: any): ApprovalRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    toolInvocationId: r.tool_invocation_id,
    proposedEffectId: r.proposed_effect_id,
    requestedByAgentId: r.requested_by_agent_id,
    requestedFromUserId: r.requested_from_user_id,
    status: r.status,
    actionSummary: r.action_summary,
    riskAxes: r.risk_axes,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByUserId: r.resolved_by_user_id,
  };
}

function rowToProposedEffect(r: any): ProposedEffect {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    connectorId: r.connector_id,
    effectType: r.effect_type,
    target: r.target ?? {},
    payload: r.payload,
    payloadHash: r.payload_hash,
    proposalVersion: r.proposal_version,
    provenance: r.provenance,
    riskAxes: r.risk_axes,
    rollbackPlan: r.rollback_plan,
    reviewerId: r.reviewer_id,
    reviewerAuthority: r.reviewer_authority,
    approvalExpiresAt: r.approval_expires_at,
    idempotencyKey: r.idempotency_key,
    executionState: r.execution_state,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    executedAt: r.executed_at,
  };
}

function rowToUserIdentity(r: any): UserIdentity {
  return {
    id: r.id,
    userId: r.user_id,
    tenantId: r.tenant_id,
    surfaceType: r.surface_type,
    externalId: r.external_id,
    verifiedAt: r.verified_at,
    verificationMethod: r.verification_method,
    status: r.status,
    credentialRef: r.credential_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAuditEvent(r: any): AuditEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    actorUserId: r.actor_user_id,
    actorAgentId: r.actor_agent_id,
    eventType: r.event_type,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    metadata: r.metadata ?? undefined,
    createdAt: r.created_at,
  };
}

export { isTerminal };
