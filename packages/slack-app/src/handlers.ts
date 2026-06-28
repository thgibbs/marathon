import { parseCheckpoint } from "@marathon/core";
import { Database } from "@marathon/db";
import type { AgentDescriptor, StructuredResult, SurfaceAdapter } from "@marathon/surface";
import {
  parseAppMention,
  parseReactionFeedback,
  type SlackAppMentionEvent,
  type SlackReactionEvent,
  type SocketEnvelope,
} from "@marathon/surface-slack";
import { InvocationRouter, Worker } from "@marathon/worker";

export interface AppDeps {
  db: Database;
  router: InvocationRouter;
  /** Worker configured with a task-driven agent step runner. */
  worker: Worker;
  delivery: SurfaceAdapter;
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent?: string;
}

export type EnvelopeAction =
  | { kind: "mention"; event: SlackAppMentionEvent; eventId?: string }
  | { kind: "reaction"; event: SlackReactionEvent }
  | { kind: "ignore" };

/** Pure classification of a Socket Mode envelope into an action. */
export function classifyEnvelope(envelope: SocketEnvelope): EnvelopeAction {
  if (envelope.type !== "events_api") return { kind: "ignore" };
  const payload = envelope.payload ?? {};
  const event = payload.event;
  if (!event || typeof event.type !== "string") return { kind: "ignore" };
  if (event.type === "app_mention") return { kind: "mention", event, eventId: payload.event_id };
  if (event.type === "reaction_added") return { kind: "reaction", event };
  return { kind: "ignore" };
}

export async function handleMention(
  deps: AppDeps,
  event: SlackAppMentionEvent,
  eventId?: string,
): Promise<void> {
  // dedupe inbound events (at-least-once delivery)
  if (eventId) {
    const fresh = await deps.db.claim(`slack:event:${eventId}`);
    if (!fresh) return;
  }

  const invocation = parseAppMention(event, {
    knownAgents: deps.agents.map((a) => a.name),
    eventId,
  });

  await deps.delivery.acknowledge(invocation.sourceRef);

  const { task } = await deps.router.route(invocation, {
    tenantId: deps.tenantId,
    agents: deps.agents,
    agentIdByName: deps.agentIdByName,
    defaultAgent: deps.defaultAgent,
  });

  // run the queued task (agent + tools) to completion
  await deps.worker.drain();

  const finalTask = await deps.db.getTask(task.id);
  const cp = parseCheckpoint(finalTask?.checkpoint);
  const cost = await deps.db.sumModelCostUsd(task.id);
  const result: StructuredResult = {
    summary: cp.findings.at(-1) ?? "(no response)",
    evidence: cp.findings.slice(0, -1),
    costUsd: cost,
  };
  await deps.delivery.deliverResult(invocation.sourceRef, result);
}

export async function handleReaction(deps: AppDeps, event: SlackReactionEvent): Promise<void> {
  const fb = parseReactionFeedback(event);
  if (!fb) return;
  const user = await deps.db.findOrCreateUserByIdentity(deps.tenantId, "slack", fb.userExternalId);
  await deps.db.recordFeedback({ tenantId: deps.tenantId, userId: user.id, feedbackType: fb.feedbackType });
}

/** Route a Socket Mode envelope to the right handler. */
export async function dispatchEnvelope(deps: AppDeps, envelope: SocketEnvelope): Promise<void> {
  const action = classifyEnvelope(envelope);
  if (action.kind === "mention") await handleMention(deps, action.event, action.eventId);
  else if (action.kind === "reaction") await handleReaction(deps, action.event);
}
