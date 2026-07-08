import { randomUUID } from "node:crypto";
import { mintLinkToken, parseCheckpoint, surfaceEventKey, type DeliveryTarget } from "@marathon/core";
import { Database } from "@marathon/db";
import { getTaskStatus, renderStatusText } from "@marathon/observability";
import { Queue } from "@marathon/queue";
import {
  DeliveryFanout,
  type AgentDescriptor,
  type StructuredResult,
  type SurfaceAdapter,
} from "@marathon/surface";
import {
  isThreadReply,
  parseAppMention,
  parseReactionFeedback,
  parseThreadReply,
  type SlackAppMentionEvent,
  type SlackMessageEvent,
  type SlackReactionEvent,
  type SocketEnvelope,
} from "@marathon/surface-slack";
import { InvocationRouter, Orchestrator, resumeWithInput, Worker } from "@marathon/worker";

export interface AppDeps {
  db: Database;
  router: InvocationRouter;
  /** Worker configured with a task-driven agent step runner. */
  worker: Worker;
  /** Resumes durable waits + spawns continuation tasks (Track 12). */
  queue: Queue;
  orchestrator: Orchestrator;
  delivery: SurfaceAdapter;
  /**
   * Cross-surface fan-out (K2). When absent, a Slack-only fan-out is built from
   * `delivery`, so non-Slack targets are skipped until their adapters are wired.
   */
  fanout?: DeliveryFanout;
  tenantId: string;
  agents: AgentDescriptor[];
  agentIdByName: Record<string, string>;
  defaultAgent?: string;
  /**
   * Identity linking (§7.20 / §2b #10): lets `/marathon link github` mint the
   * single-use signed URL. `signingKey` is the deployment master secret
   * (`MARATHON_SECRET_KEY` — the GitHub app verifies with the same key);
   * `baseUrl` is the public base of the GitHub app's HTTP server
   * (`MARATHON_LINK_BASE_URL`), which hosts the OAuth start/callback routes.
   * Unset → the command replies that linking isn't configured.
   */
  identityLink?: { signingKey: string; baseUrl: string };
  /** Test seam for the response_url POST; default global fetch. */
  fetchImpl?: typeof fetch;
}

/** A slash-command invocation (`/marathon …`), as delivered over Socket Mode. */
export interface SlackSlashCommand {
  command: string;
  text: string;
  user_id: string;
  team_id?: string;
  channel_id?: string;
  /** POST here to reply (ephemeral by default) — Socket Mode ACKs are bare. */
  response_url?: string;
}

export type EnvelopeAction =
  | { kind: "mention"; event: SlackAppMentionEvent; eventId?: string }
  | { kind: "reply"; event: SlackMessageEvent; eventId?: string }
  | { kind: "reaction"; event: SlackReactionEvent }
  | { kind: "command"; command: SlackSlashCommand }
  | { kind: "ignore" };

/** Pure classification of a Socket Mode envelope into an action. */
export function classifyEnvelope(envelope: SocketEnvelope): EnvelopeAction {
  // §2b #10: slash commands arrive as their own envelope type.
  if (envelope.type === "slash_commands") {
    const p = envelope.payload ?? {};
    if (typeof p.command !== "string" || typeof p.user_id !== "string") return { kind: "ignore" };
    return {
      kind: "command",
      command: {
        command: p.command,
        text: String(p.text ?? ""),
        user_id: p.user_id,
        team_id: p.team_id,
        channel_id: p.channel_id,
        response_url: p.response_url,
      },
    };
  }
  if (envelope.type !== "events_api") return { kind: "ignore" };
  const payload = envelope.payload ?? {};
  const event = payload.event;
  if (!event || typeof event.type !== "string") return { kind: "ignore" };
  if (event.type === "app_mention") return { kind: "mention", event, eventId: payload.event_id };
  // Track 12: a plain human reply inside a thread (mentions arrive separately
  // as app_mention and must not double-route).
  if (event.type === "message" && isThreadReply(event)) return { kind: "reply", event, eventId: payload.event_id };
  if (event.type === "reaction_added") return { kind: "reaction", event };
  return { kind: "ignore" };
}

/**
 * Drain the worker, then report the task's outcome to its targets: a durable
 * wait posts the clarifying question; a finished run posts the result (K2
 * fan-out). Shared by the mention and reply paths.
 */
async function runAndReport(deps: AppDeps, taskId: string, fallbackRef: Record<string, unknown>): Promise<void> {
  await deps.worker.drain();

  const finalTask = await deps.db.getTask(taskId);

  // Durable wait (Track 12, §11.6): nothing to report here — the worker
  // published the question BEFORE parking (onWaiting/makeWaitingNotifier), so
  // the wait only exists once the question was durably heard.
  if (finalTask?.status === "waiting_for_input") return;

  const cp = parseCheckpoint(finalTask?.checkpoint);
  const targets: DeliveryTarget[] =
    finalTask?.deliveryTargets ?? [{ surfaceType: "slack", ref: fallbackRef }];
  const fanout = deps.fanout ?? new DeliveryFanout({ slack: deps.delivery }, deps.db);
  const cost = await deps.db.sumModelCostUsd(taskId);
  const result: StructuredResult = {
    summary:
      finalTask?.status === "failed"
        ? summarizeTaskFailure(finalTask.lastError)
        : (cp.findings.at(-1) ?? "(no response)"),
    evidence: cp.findings.slice(0, -1),
    costUsd: cost,
  };
  await fanout.deliverResult(taskId, targets, result);
}

/**
 * A `failed` task never appended a checkpoint finding when the failure
 * happened pre-turn (e.g. budget exhaustion) — so `runAndReport` renders a
 * user-safe summary instead of falling back to "(no response)"
 * (design/30-task-failure-reporting.md §30.2). Matches `BudgetExceededError`
 * the same way `classifyError` matches transient errors: by message pattern.
 *
 * `lastError` (`String(err)`, persisted by worker.ts's `safeFailTask`) can
 * originate from provider responses, tool/gateway errors, config parsing, or
 * connector payloads — none of it is guaranteed redacted, so only the
 * allowlisted budget case echoes any of its text; everything else gets a
 * bounded generic message and the raw string stays in `last_error` for
 * logs/admin only.
 */
export function summarizeTaskFailure(lastError: string | null): string {
  // `lastError` is `String(err)` (worker.ts's safeFailTask), which stringifies
  // as "BudgetExceededError: budget exceeded: spent $X of $Y" — match the
  // substring, not an anchored prefix.
  if (lastError && /budget exceeded/i.test(lastError)) {
    return "Budget exhausted — this task's spending cap was reached before it could finish.";
  }
  return "This task failed before it could finish; check task logs for details.";
}

/** Is this mention a status ask (Track 16, §15.3) rather than new work? */
export function isStatusAsk(text: string): boolean {
  return text.trim().toLowerCase() === "status";
}

/**
 * The deterministic doc-task shape for Slack drafting (§2b #16): a mention
 * whose ask STARTS with the verb "draft" ("@marathon draft a plan for …" —
 * the kernel's canonical opening move). A leading keyword, not a content
 * classifier: no interpretation decides whether the doc contract + no-op
 * evidence check apply. Everything else stays a general agent task (which can
 * still call document.create — this shape only adds the contract/evidence).
 */
export function isDocDraftAsk(text: string): boolean {
  return /^draft\b/i.test(text.trim());
}

/**
 * `@agent status` in a task's thread (Track 16, §15.3): reply with what the
 * task is doing, what it finished, what it waits on, and cost so far. Read-only
 * — never routes a task.
 */
export async function handleStatusAsk(
  deps: AppDeps,
  event: SlackAppMentionEvent,
  sourceRef: Record<string, unknown>,
): Promise<void> {
  // The mention's thread anchors the lookup: asked inside a task's thread,
  // thread_ts is the original ask's ts — the key tasks are stored under.
  const threadTs = event.thread_ts ?? event.ts;
  const task = await deps.db.findLatestTaskByThread(deps.tenantId, event.channel, threadTs);
  if (!task) {
    await deps.delivery.postProgress(sourceRef, "I don't see a task in this thread — ask me for status in the thread where you asked for the work.");
    return;
  }
  const view = await getTaskStatus(deps.db, deps.tenantId, task.id);
  await deps.delivery.postProgress(sourceRef, view ? renderStatusText(view) : "I couldn't load that task's status.");
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

  // Status ask (Track 16): answer from the task records, don't start work.
  if (isStatusAsk(invocation.text)) {
    await handleStatusAsk(deps, event, invocation.sourceRef);
    return;
  }

  // Doc-task shape (§2b #16): "@marathon draft …" marks the task so the step
  // runner applies the doc-tool contract + the post-turn evidence check. The
  // marker rides in the source ref (the GitHub app's kind-discriminator
  // pattern); the thread anchor keys (channel/thread_ts) are untouched.
  if (isDocDraftAsk(invocation.text)) {
    invocation.sourceRef = { ...invocation.sourceRef, kind: "doc_draft" };
  }

  await deps.delivery.acknowledge(invocation.sourceRef);

  const { task } = await deps.router.route(invocation, {
    tenantId: deps.tenantId,
    agents: deps.agents,
    agentIdByName: deps.agentIdByName,
    defaultAgent: deps.defaultAgent,
  });

  // run the queued task (agent + tools) and report outcome/question
  await runAndReport(deps, task.id, invocation.sourceRef);
}

/**
 * A plain reply in a task's thread (Track 12, K3): route it as a continuation
 * of the loop the thread belongs to —
 *   - task waiting_for_input  -> the reply is the ANSWER; resume the durable wait;
 *   - task finished           -> the reply is a follow-up; spawn a continuation
 *                                task chained to it (same agent, inherited targets);
 *   - task still running      -> leave it alone (chatter while working).
 * Threads with no Marathon task are ignored — only mentions start new loops.
 */
export async function handleThreadReply(
  deps: AppDeps,
  event: SlackMessageEvent,
  eventId?: string,
): Promise<void> {
  // Deliberately NO upfront event claim: Slack's redelivery is the retry
  // mechanism for a crashed half-resume. Both branches below are idempotent on
  // the surface event (resume's convergent enqueue / the orchestrator's submit
  // key), so duplicates cannot double-run — but a lost partial attempt is
  // repaired by the next delivery instead of being swallowed by a stale claim.
  const invocation = parseThreadReply(event, { eventId });
  const threadTs = String(invocation.sourceRef.thread_ts);
  const task = await deps.db.findLatestTaskByThread(deps.tenantId, event.channel, threadTs);
  if (!task) return;

  if (task.status === "waiting_for_input") {
    const outcome = await resumeWithInput(deps.db, deps.queue, task.id, invocation.text, {
      idempotencyKey: eventId ? surfaceEventKey("slack", eventId) : undefined,
    });
    if (!outcome.resumed) return;
    await runAndReport(deps, task.id, invocation.sourceRef);
    return;
  }

  if (task.status === "running" || task.status === "queued" || task.status === "retrying") return;

  // Finished loop + new feedback -> continuation task chained to it (K3).
  const { task: continuation, deduped } = await deps.orchestrator.submit({
    tenantId: deps.tenantId,
    agentId: task.agentId ?? undefined,
    agentVersionId: task.agentVersionId ?? undefined,
    invokingUserId: task.invokingUserId ?? undefined,
    sourceTaskId: task.id,
    sourceType: "slack",
    sourceRef: invocation.sourceRef,
    deliveryTargets: task.deliveryTargets ?? undefined,
    inputText: invocation.text,
    idempotencyKey: eventId ? surfaceEventKey("slack", eventId) : undefined,
  });
  if (deduped) return;
  await deps.delivery.acknowledge(invocation.sourceRef);
  await runAndReport(deps, continuation.id, invocation.sourceRef);
}

/**
 * `/marathon link github` (§7.20 / §2b #10): reply ephemerally with a
 * single-use signed URL bound to (tenant, slack_user_id, nonce, expiry). The
 * Slack identity is PROVEN by this authenticated interaction — the token
 * carries that proof to the GitHub OAuth callback, which writes the verified
 * `UserIdentity`. Identities are proven, never typed.
 */
export async function handleSlashCommand(deps: AppDeps, cmd: SlackSlashCommand): Promise<void> {
  const respond = async (text: string): Promise<void> => {
    if (!cmd.response_url) return;
    const f = deps.fetchImpl ?? fetch;
    await f(cmd.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  };

  const sub = cmd.text.trim().toLowerCase();
  if (sub !== "link github") {
    await respond("Usage: `/marathon link github` — link your GitHub account so Marathon can act with your access.");
    return;
  }
  if (!deps.identityLink) {
    await respond(
      "Identity linking isn't configured on this deployment (MARATHON_LINK_BASE_URL + MARATHON_SECRET_KEY + the GitHub App's OAuth credentials are required).",
    );
    return;
  }
  const token = mintLinkToken(
    {
      tenantId: deps.tenantId,
      slackUserId: cmd.user_id,
      nonce: randomUUID(),
      expiresAt: Date.now() + LINK_TOKEN_TTL_MS,
    },
    deps.identityLink.signingKey,
  );
  const url = `${deps.identityLink.baseUrl.replace(/\/$/, "")}/auth/github/start?token=${encodeURIComponent(token)}`;
  await respond(
    `To link your GitHub account, open this link (valid ${Math.round(LINK_TOKEN_TTL_MS / 60_000)} minutes, single-use):\n${url}`,
  );
}

/** Link URLs are short-lived: the click should follow the ask. */
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * The "link your GitHub" call-to-action (§7.20): the second entry point to
 * identity linking. When an on-behalf-of action is denied because the user
 * has no verified GitHub link, the denial should carry this — "the moment the
 * user hits the wall is the moment to offer the fix". A reusable string so
 * whichever denial path adds on-behalf-of enforcement can append it.
 */
export function linkGithubCta(): string {
  return "Run `/marathon link github` to connect your GitHub account so I can act with your access.";
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
  else if (action.kind === "reply") await handleThreadReply(deps, action.event, action.eventId);
  else if (action.kind === "reaction") await handleReaction(deps, action.event);
  else if (action.kind === "command") await handleSlashCommand(deps, action.command);
}
