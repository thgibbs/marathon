import type { NormalizedInvocation } from "@marathon/surface";

export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  team?: string;
}

export interface ParseOptions {
  knownAgents?: string[];
  eventId?: string;
}

/**
 * Parse a Slack `app_mention` into a NormalizedInvocation. The leading bot
 * mention (`<@U…>`) is stripped; if the next word is a known agent, it's the
 * target agent, otherwise the default agent is used.
 */
export function parseAppMention(event: SlackAppMentionEvent, opts: ParseOptions = {}): NormalizedInvocation {
  const stripped = event.text.replace(/^\s*<@[^>]+>\s*/, "").trim();
  let agentName: string | null = null;
  let text = stripped;
  const m = stripped.match(/^([A-Za-z][\w-]*)\s+([\s\S]+)$/);
  if (m && opts.knownAgents?.includes(m[1]!)) {
    agentName = m[1]!;
    text = m[2]!.trim();
  }
  return {
    surfaceType: "slack",
    // `ts` is the message's own timestamp — distinct from `thread_ts` for a
    // mention inside an existing thread (§31.4); it's the ack-reaction target.
    sourceRef: { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, ts: event.ts, event_id: opts.eventId },
    userExternalId: event.user,
    teamExternalId: event.team,
    agentName,
    text,
    eventId: opts.eventId,
  };
}

/** A plain `message` event — the shape thread replies arrive as (Track 12). */
export interface SlackMessageEvent {
  type: "message";
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  /** Set for bot posts (including our own) — never route those as replies. */
  bot_id?: string;
  /** Set for edits/joins/etc. — only plain user messages are replies. */
  subtype?: string;
}

/**
 * Classify a `message` event as a thread reply worth routing (Track 12): a
 * plain human message inside a thread. Mentions are excluded — they arrive
 * separately as `app_mention` and would double-handle.
 */
export function isThreadReply(event: SlackMessageEvent): boolean {
  return (
    event.type === "message" &&
    event.subtype === undefined &&
    event.bot_id === undefined &&
    typeof event.thread_ts === "string" &&
    event.thread_ts !== event.ts && // the thread opener is not a reply
    typeof event.user === "string" &&
    typeof event.text === "string" &&
    event.text.trim() !== "" &&
    !/<@[^>]+>/.test(event.text)
  );
}

/** Parse a thread reply into a NormalizedInvocation anchored to its thread. */
export function parseThreadReply(event: SlackMessageEvent, opts: ParseOptions = {}): NormalizedInvocation {
  return {
    surfaceType: "slack",
    // `ts` is the reply's own timestamp — the ack-reaction target (§31.4).
    sourceRef: { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, ts: event.ts, event_id: opts.eventId },
    userExternalId: event.user ?? "unknown",
    teamExternalId: event.team,
    agentName: null,
    text: (event.text ?? "").trim(),
    eventId: opts.eventId,
  };
}

export interface SlackReactionEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item?: { channel?: string; ts?: string };
}

const REACTION_FEEDBACK: Record<string, "thumbs_up" | "thumbs_down"> = {
  "+1": "thumbs_up",
  thumbsup: "thumbs_up",
  white_check_mark: "thumbs_up",
  "-1": "thumbs_down",
  thumbsdown: "thumbs_down",
};

export function parseReactionFeedback(
  event: SlackReactionEvent,
): { feedbackType: "thumbs_up" | "thumbs_down"; userExternalId: string; itemTs?: string } | null {
  if (event.type !== "reaction_added") return null;
  const feedbackType = REACTION_FEEDBACK[event.reaction];
  if (!feedbackType) return null;
  return { feedbackType, userExternalId: event.user, itemTs: event.item?.ts };
}
