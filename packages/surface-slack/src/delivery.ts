import {
  renderResultText,
  type StructuredResult,
  type SurfaceAdapter,
  type SurfaceMessage,
} from "@marathon/surface";
import type { SlackClient } from "./client";

function ref(r: Record<string, unknown>): { channel: string; threadTs?: string } {
  return { channel: String(r.channel), threadTs: r.thread_ts ? String(r.thread_ts) : undefined };
}

/** Slack implementation of the surface delivery side (threaded replies). */
export class SlackDelivery implements SurfaceAdapter {
  constructor(private readonly client: SlackClient) {}

  async acknowledge(r: Record<string, unknown>): Promise<void> {
    const { channel, threadTs } = ref(r);
    await this.client.postMessage(channel, "_on it…_", threadTs);
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
