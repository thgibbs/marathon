import {
  renderResultText,
  type StructuredResult,
  type SurfaceAdapter,
  type SurfaceMessage,
} from "@marathon/surface";
import type { SlackClient } from "./client";

/** Slack's :+1: reaction name (no colons) — the ack signal (§31.3). */
const ACK_REACTION = "+1";

function ref(r: Record<string, unknown>): { channel: string; threadTs?: string; ts?: string } {
  return {
    channel: String(r.channel),
    threadTs: r.thread_ts ? String(r.thread_ts) : undefined,
    ts: r.ts ? String(r.ts) : undefined,
  };
}

/** Slack implementation of the surface delivery side (threaded replies). */
export class SlackDelivery implements SurfaceAdapter {
  /** §31.6: the missing-scope warning is loud but logged at most once per process. */
  private warnedMissingScope = false;

  constructor(private readonly client: SlackClient) {}

  /**
   * React :+1: to the triggering message (§31.3) instead of posting text —
   * `ts` (the message's own timestamp) when available, else `thread_ts` so any
   * caller with only a thread anchor still gets a reaction somewhere sane.
   * Best-effort (§31.8): reacting can fail (message deleted, rate limited, or
   * — per §31.6 — a `missing_scope` error) and must never fail the task.
   */
  async acknowledge(r: Record<string, unknown>): Promise<void> {
    const { channel, threadTs, ts } = ref(r);
    const target = ts ?? threadTs;
    if (!target) return;
    try {
      await this.client.addReaction(channel, target, ACK_REACTION);
    } catch (e) {
      // §31.6: this failure mode is otherwise silent and affects every ack
      // (not a one-off), so it gets a loud warning before being swallowed.
      if (!this.warnedMissingScope && /missing_scope/.test(String(e))) {
        this.warnedMissingScope = true;
        console.warn(
          "[slack] ack reactions disabled: bot token is missing the `reactions:write` scope — reinstall/re-authorize the Slack app",
        );
      }
    }
  }

  async postProgress(r: Record<string, unknown>, message: string): Promise<void> {
    const { channel, threadTs } = ref(r);
    await this.client.postMessage(channel, message, threadTs);
  }

  async deliverResult(r: Record<string, unknown>, result: StructuredResult): Promise<void> {
    const { channel, threadTs } = ref(r);
    await this.client.postMessage(channel, renderResultText(result), threadTs);
  }

  /** Thread history for prompt assembly (Track 12, §7.18); untrusted — fence it. */
  async loadContext(r: Record<string, unknown>, opts?: { limit?: number }): Promise<SurfaceMessage[]> {
    const { channel, threadTs } = ref(r);
    if (!threadTs) return [];
    const replies = await this.client.fetchReplies(channel, threadTs, opts?.limit ?? 50);
    return replies.map((m) => ({ author: m.user, text: m.text, ts: m.ts }));
  }
}
