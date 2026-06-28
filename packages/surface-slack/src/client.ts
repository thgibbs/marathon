export interface SlackPostResult {
  ts: string;
}

export interface SlackClient {
  postMessage(channel: string, text: string, threadTs?: string): Promise<SlackPostResult>;
}

/** Real Slack Web API client (bot token). */
export class RealSlackClient implements SlackClient {
  constructor(private readonly token: string) {}

  async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackPostResult> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, thread_ts: threadTs }),
    });
    const j = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!j.ok) throw new Error(`slack chat.postMessage: ${j.error}`);
    return { ts: j.ts ?? "" };
  }
}

/** Deterministic client for tests/CI — records posted messages. */
export class FakeSlackClient implements SlackClient {
  public readonly messages: Array<{ channel: string; text: string; threadTs?: string; ts: string }> = [];
  private seq = 1;

  async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackPostResult> {
    const ts = `1700000000.${String(this.seq++).padStart(6, "0")}`;
    this.messages.push({ channel, text, threadTs, ts });
    return { ts };
  }
}
