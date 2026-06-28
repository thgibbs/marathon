/**
 * Socket Mode client: a persistent inbound connection (no public URL). Opens a
 * WebSocket via apps.connections.open, ACKs each envelope immediately, then hands
 * the payload to the handler asynchronously, and reconnects on disconnect.
 * Uses the global WebSocket (Node ≥ 22).
 */
export interface SocketEnvelope {
  type: string; // "events_api" | "interactive" | "slash_commands" | ...
  envelope_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  accepts_response_payload?: boolean;
}

export type SocketEnvelopeHandler = (envelope: SocketEnvelope) => void | Promise<void>;

export interface SocketModeOptions {
  onConnected?: () => void;
  onError?: (err: unknown) => void;
}

export class SocketModeClient {
  // eslint-disable-next-line no-undef
  private ws?: WebSocket;
  private stopped = false;

  constructor(
    private readonly appToken: string,
    private readonly opts: SocketModeOptions = {},
  ) {}

  async start(handler: SocketEnvelopeHandler): Promise<void> {
    this.stopped = false;
    await this.connect(handler);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private async connect(handler: SocketEnvelopeHandler): Promise<void> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const j = (await res.json()) as { ok: boolean; url?: string; error?: string };
    if (!j.ok || !j.url) throw new Error(`apps.connections.open: ${j.error ?? "no url"}`);

    // eslint-disable-next-line no-undef
    const ws = new WebSocket(j.url);
    this.ws = ws;

    ws.onmessage = (ev: MessageEvent) => {
      let msg: SocketEnvelope & { type: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.opts.onConnected?.();
        return;
      }
      if (msg.type === "disconnect") {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (msg.envelope_id) {
        // ACK immediately (must be within ~3s), then process async.
        try {
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        } catch {
          /* ignore */
        }
        Promise.resolve(handler(msg)).catch((e) => this.opts.onError?.(e));
      }
    };

    ws.onclose = () => {
      if (!this.stopped) setTimeout(() => void this.connect(handler).catch((e) => this.opts.onError?.(e)), 1000);
    };
    ws.onerror = () => {
      this.opts.onError?.(new Error("socket mode connection error"));
    };
  }
}
