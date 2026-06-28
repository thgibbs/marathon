import { renderResultText, type StructuredResult, type SurfaceAdapter } from "@marathon/surface";
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
}
