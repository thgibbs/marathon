export interface SlackPostResult {
  ts: string;
}

export interface SlackThreadMessage {
  user?: string;
  text: string;
  ts: string;
}

export interface SlackClient {
  postMessage(channel: string, text: string, threadTs?: string): Promise<SlackPostResult>;
  /** The messages of a thread, oldest first (context loading, Track 12). */
  fetchReplies(channel: string, threadTs: string, limit?: number): Promise<SlackThreadMessage[]>;
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

  async fetchReplies(channel: string, threadTs: string, limit = 50): Promise<SlackThreadMessage[]> {
    const params = new URLSearchParams({ channel, ts: threadTs, limit: String(limit) });
    const res = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: Array<{ user?: string; text?: string; ts?: string }>;
    };
    if (!j.ok) throw new Error(`slack conversations.replies: ${j.error}`);
    return (j.messages ?? []).map((m) => ({ user: m.user, text: m.text ?? "", ts: m.ts ?? "" }));
  }
}

/** Deterministic client for tests/CI — records posted messages. */
export class FakeSlackClient implements SlackClient {
  public readonly messages: Array<{ channel: string; text: string; threadTs?: string; ts: string }> = [];
  /** Seedable thread history by `channel:threadTs` (returned first by fetchReplies). */
  public readonly threads = new Map<string, SlackThreadMessage[]>();
  private seq = 1;

  async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackPostResult> {
    const ts = `1700000000.${String(this.seq++).padStart(6, "0")}`;
    this.messages.push({ channel, text, threadTs, ts });
    return { ts };
  }

  async fetchReplies(channel: string, threadTs: string, limit = 50): Promise<SlackThreadMessage[]> {
    const seeded = this.threads.get(`${channel}:${threadTs}`) ?? [];
    const posted = this.messages
      .filter((m) => m.channel === channel && m.threadTs === threadTs)
      .map((m) => ({ text: m.text, ts: m.ts }));
    return [...seeded, ...posted].slice(0, limit);
  }
}
