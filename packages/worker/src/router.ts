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
   * When true, the submitted task will not be leasable by a queue Worker
   * while the inline run is in flight (the job row is pre-leased). Pass this
   * from call sites that drive the task inline immediately after routing, and
   * call the returned `completeInline` handle when the inline work finishes.
   * See Orchestrator.submit's `inline` option for the full contract.
   */
  inline?: boolean;
}

export interface RouteResult {
  task: Task;
  agentName: string;
  deduped: boolean;
  /**
   * Present on a fresh inline submit (inline: true, non-deduped, with a
   * surface event id): the caller MUST call it once the inline work finishes
   * (success paths only — on a thrown error do NOT call it; the expiring
   * lease is the crash-recovery path). Undefined on dedup or non-inline.
   */
  completeInline?: () => Promise<void>;
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

    const { task, deduped, completeInline } = await this.orchestrator.submit({
      tenantId: opts.tenantId,
      agentId,
      invokingUserId: user.id,
      sourceType: invocation.surfaceType,
      sourceRef: invocation.sourceRef,
      inputText: invocation.text,
      idempotencyKey,
      inline: opts.inline,
    });

    return { task, agentName: agent.name, deduped, completeInline };
  }
}
