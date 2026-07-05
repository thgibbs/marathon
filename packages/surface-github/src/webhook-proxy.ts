/**
 * Dev webhook proxy (roadmap §2b #12): GitHub webhooks are a push and need
 * inbound reachability; Slack avoids this with Socket Mode (outbound
 * websocket) but GitHub has no equivalent. Instead of a tunnel, point the
 * GitHub App's webhook URL once at a stable smee.io channel and SUBSCRIBE
 * outbound to it here — smee relays each delivery to every subscriber as a
 * server-sent event carrying the original headers plus the parsed JSON body.
 *
 * The replayed delivery goes through the SAME signature-verified handler as a
 * direct one: GitHub serializes JSON payloads compactly, so
 * `JSON.stringify(body)` reconstructs the exact signed bytes and the
 * X-Hub-Signature-256 check still applies (a mismatch surfaces as a 401,
 * never silent acceptance). Dev-only — production keeps the plain receiver.
 */

/** One relayed webhook delivery, shaped for the receiver's handler. */
export interface ProxiedWebhookDelivery {
  eventType: string;
  deliveryId?: string;
  signature?: string;
  rawBody: string;
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental server-sent-events parser (the subset smee emits). */
export class SseParser {
  private buffer = "";
  private eventType = "";
  private dataLines: string[] = [];

  /** Feed a chunk; returns the events completed by it (blank-line terminated). */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        // Dispatch named events even with an empty data buffer (smee's
        // `ready` handshake); bare keep-alive blank lines dispatch nothing.
        if (this.dataLines.length > 0 || this.eventType !== "") {
          events.push({ event: this.eventType || "message", data: this.dataLines.join("\n") });
        }
        this.eventType = "";
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.eventType = value;
      else if (field === "data") this.dataLines.push(value);
      // id / retry: not used by smee's relay
    }
    return events;
  }
}

/**
 * Convert one smee `message` event into a webhook delivery. The event data is
 * a JSON object with the original request headers (lowercased) as top-level
 * keys plus `body` (the payload, parsed), `query`, and `timestamp`. Returns
 * undefined for anything that isn't a JSON-bodied GitHub delivery.
 */
export function parseSmeeDelivery(data: string): ProxiedWebhookDelivery | undefined {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const eventType = msg["x-github-event"];
  if (typeof eventType !== "string" || eventType === "" || msg.body === undefined) return undefined;
  return {
    eventType,
    deliveryId: typeof msg["x-github-delivery"] === "string" ? (msg["x-github-delivery"] as string) : undefined,
    signature: typeof msg["x-hub-signature-256"] === "string" ? (msg["x-hub-signature-256"] as string) : undefined,
    rawBody: JSON.stringify(msg.body),
  };
}

export type WebhookProxyHandler = (delivery: ProxiedWebhookDelivery) => void | Promise<void>;

export interface WebhookProxyOptions {
  onConnected?: () => void;
  onError?: (err: unknown) => void;
  /** Delay before reconnecting after a dropped/failed stream (default 1s). */
  reconnectDelayMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Persistent outbound subscription to a smee.io channel: connect over SSE,
 * hand each relayed delivery to the handler, reconnect on drop. The GitHub
 * parallel of `SocketModeClient` (surface-slack).
 */
export class WebhookProxyClient {
  private stopped = false;
  private abort?: AbortController;

  constructor(
    private readonly channelUrl: string,
    private readonly opts: WebhookProxyOptions = {},
  ) {}

  async start(handler: WebhookProxyHandler): Promise<void> {
    this.stopped = false;
    await this.connect(handler);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.abort?.abort();
    } catch {
      /* ignore */
    }
  }

  private async connect(handler: WebhookProxyHandler): Promise<void> {
    if (this.stopped) return;
    const fetchFn = this.opts.fetchFn ?? fetch;
    this.abort = new AbortController();
    try {
      const res = await fetchFn(this.channelUrl, {
        headers: { accept: "text/event-stream" },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`webhook proxy: HTTP ${res.status} from ${this.channelUrl}`);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (event.event === "ready") {
            this.opts.onConnected?.();
            continue;
          }
          if (event.event !== "message") continue; // ping etc.
          const delivery = parseSmeeDelivery(event.data);
          if (!delivery) continue;
          Promise.resolve(handler(delivery)).catch((e) => this.opts.onError?.(e));
        }
      }
    } catch (e) {
      if (!this.stopped) this.opts.onError?.(e);
    }
    // The stream ended (smee drops idle connections) or errored: resubscribe.
    if (!this.stopped) {
      setTimeout(() => void this.connect(handler), this.opts.reconnectDelayMs ?? 1000);
    }
  }
}
