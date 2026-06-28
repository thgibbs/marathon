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
    sourceRef: { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, event_id: opts.eventId },
    userExternalId: event.user,
    teamExternalId: event.team,
    agentName,
    text,
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
