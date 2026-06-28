import { Pool } from "pg";
import {
  assertTransition,
  isTerminal,
  type AuditWriter,
  type AuditEvent,
  type Agent,
  type AgentVersion,
  type Id,
  type NewAuditEvent,
  type NewModelInvocation,
  type Role,
  type SurfaceType,
  type Task,
  type TaskStatus,
  type Tenant,
  type User,
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
export class Database implements AuditWriter {
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

  async createTask(input: {
    tenantId: Id;
    agentId?: Id;
    agentVersionId?: Id;
    invokingUserId?: Id;
    sourceType: SurfaceType;
    sourceRef?: Record<string, unknown>;
    inputText?: string;
  }): Promise<Task> {
    const { rows } = await this.pool.query(
      `insert into task(tenant_id, agent_id, agent_version_id, invoking_user_id,
                        source_type, source_ref, input_text)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        input.tenantId,
        input.agentId ?? null,
        input.agentVersionId ?? null,
        input.invokingUserId ?? null,
        input.sourceType,
        JSON.stringify(input.sourceRef ?? {}),
        input.inputText ?? null,
      ],
    );
    return rowToTask(rows[0]);
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
    checkpoint: Record<string, unknown>,
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
    riskLevel?: string | null;
    inputSummary?: string | null;
    outputSummary?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `insert into tool_invocation(task_id, tool_id, status, risk_level, input_summary, output_summary, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        rec.taskId,
        rec.toolId,
        rec.status,
        rec.riskLevel ?? null,
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

  async sumModelCostUsd(taskId: Id): Promise<number> {
    const { rows } = await this.pool.query(
      `select coalesce(sum(cost_usd), 0)::float8 as total from model_invocation where task_id = $1`,
      [taskId],
    );
    return rows[0].total as number;
  }
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
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    deliveryTargets: r.delivery_targets,
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
