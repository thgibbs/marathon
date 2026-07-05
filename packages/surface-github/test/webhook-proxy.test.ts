import { describe, expect, it, vi } from "vitest";
import { computeGithubSignature, verifyGithubSignature } from "../src/signature";
import { parseSmeeDelivery, SseParser, WebhookProxyClient, type ProxiedWebhookDelivery } from "../src/webhook-proxy";

describe("SseParser", () => {
  it("parses a message event split across chunks", () => {
    const p = new SseParser();
    expect(p.push("data: {\"a\"")).toEqual([]);
    expect(p.push(":1}\n\n")).toEqual([{ event: "message", data: '{"a":1}' }]);
  });

  it("joins multi-line data and honors event types", () => {
    const p = new SseParser();
    const events = p.push("event: ready\ndata: {}\n\nevent: ping\ndata: x\ndata: y\n\n");
    expect(events).toEqual([
      { event: "ready", data: "{}" },
      { event: "ping", data: "x\ny" },
    ]);
  });

  it("handles CRLF, comments, and a named event with no data", () => {
    const p = new SseParser();
    expect(p.push(": keep-alive\r\n\r\nevent: ready\r\n\r\n")).toEqual([{ event: "ready", data: "" }]);
  });

  it("dispatches nothing on bare blank lines", () => {
    expect(new SseParser().push("\n\n\n")).toEqual([]);
  });
});

describe("parseSmeeDelivery", () => {
  const payload = { action: "created", comment: { body: "@marathon hi" } };
  const smee = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      host: "smee.io",
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": "sha256=abc",
      body: payload,
      query: {},
      timestamp: 1751700000000,
      ...over,
    });

  it("converts a relayed delivery to the receiver's request shape", () => {
    expect(parseSmeeDelivery(smee())).toEqual({
      eventType: "issue_comment",
      deliveryId: "d-1",
      signature: "sha256=abc",
      rawBody: JSON.stringify(payload),
    });
  });

  it("reconstructs bytes that verify against the original signature", () => {
    // GitHub signs the compact JSON it sends; smee relays the parsed body, and
    // JSON.stringify round-trips compact JSON byte-for-byte.
    const rawBody = JSON.stringify(payload);
    const signature = computeGithubSignature("whsec", rawBody);
    const delivery = parseSmeeDelivery(smee({ "x-hub-signature-256": signature }))!;
    expect(verifyGithubSignature("whsec", delivery.rawBody, delivery.signature)).toBe(true);
  });

  it("rejects non-JSON, missing event type, and missing body", () => {
    expect(parseSmeeDelivery("not json{")).toBeUndefined();
    expect(parseSmeeDelivery(smee({ "x-github-event": undefined }))).toBeUndefined();
    expect(parseSmeeDelivery(smee({ body: undefined }))).toBeUndefined();
  });
});

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("WebhookProxyClient", () => {
  it("subscribes, signals ready, hands deliveries to the handler", async () => {
    const stream =
      "event: ready\ndata: {}\n\n" +
      `data: ${JSON.stringify({ "x-github-event": "ping", "x-github-delivery": "d-9", body: { zen: "hi" } })}\n\n`;
    const fetchFn = vi.fn(async () => sseResponse(stream));
    const connected = vi.fn();
    const deliveries: ProxiedWebhookDelivery[] = [];
    const client = new WebhookProxyClient("https://smee.io/test", { fetchFn, onConnected: connected });
    await client.start((d) => {
      deliveries.push(d);
      client.stop(); // ends the test stream without a reconnect
    });
    expect(connected).toHaveBeenCalledOnce();
    expect(deliveries).toEqual([{ eventType: "ping", deliveryId: "d-9", signature: undefined, rawBody: '{"zen":"hi"}' }]);
    expect(fetchFn).toHaveBeenCalledWith("https://smee.io/test", expect.objectContaining({ headers: { accept: "text/event-stream" } }));
  });

  it("reports errors and reconnects after a failed subscribe", async () => {
    let calls = 0;
    const onError = vi.fn();
    let resolveConnected!: () => void;
    const connected = new Promise<void>((resolve) => (resolveConnected = resolve));
    const client: WebhookProxyClient = new WebhookProxyClient("https://smee.io/test", {
      onError,
      reconnectDelayMs: 1,
      fetchFn: async () => {
        calls++;
        if (calls === 1) throw new Error("down");
        return sseResponse("event: ready\ndata: {}\n\n");
      },
      onConnected: () => {
        client.stop();
        resolveConnected();
      },
    });
    await client.start(() => {});
    await connected;
    expect(onError).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
  });
});
