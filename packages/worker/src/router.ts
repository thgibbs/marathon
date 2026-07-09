import { surfaceEventKey, type Id, type Task } from "@marathon/core";
import { Database } from "@marathon/db";
import { selectAgent, type AgentDescriptor, type NormalizedInvocation } from "@marathon/surface";
import { Orchestrator } from "./worker";

export interface RouteOptions {
  tenantId: Id;
  agents: AgentDescriptor[];
  /** Maps agent name -> agent id for the tenant. */
  agentIdByName: Record<string, Id>;
  defaultAgent?: string;
  /**
   * When true, the submitted task will not be leasable by a queue Worker.
   * Pass this from call sites that drive the task inline immediately after
   * routing. See Orchestrator.submit's `inline` option for the full contract.
   */
  inline?: boolean;
}

export interface RouteResult {
  task: Task;
  agentName: string;
  deduped: boolean;
}

/**
 * The Invocation Router (design.md §9.2): resolve the agent (default-agent
 * selection), resolve/create the invoking user, and submit a durable task.
 * Idempotent on the surface event id, so duplicate events don't double-run.
 */
export class InvocationRouter {
  constructor(
    private readonly db: Database,
    private readonly orchestrator: Orchestrator,
  ) {}

  async route(invocation: NormalizedInvocation, opts: RouteOptions): Promise<RouteResult> {
    const agent = selectAgent(invocation, opts.agents, opts.defaultAgent);
    if (!agent) throw new Error("no agent could be resolved for the invocation");
    const agentId = opts.agentIdByName[agent.name];

    const user = await this.db.findOrCreateUserByIdentity(
      opts.tenantId,
      invocation.surfaceType,
      invocation.userExternalId,
    );

    const idempotencyKey = invocation.eventId
      ? surfaceEventKey(invocation.surfaceType, invocation.eventId)
      : undefined;

    const { task, deduped } = await this.orchestrator.submit({
      tenantId: opts.tenantId,
      agentId,
      invokingUserId: user.id,
      sourceType: invocation.surfaceType,
      sourceRef: invocation.sourceRef,
      inputText: invocation.text,
      idempotencyKey,
      inline: opts.inline,
    });

    return { task, agentName: agent.name, deduped };
  }
}
