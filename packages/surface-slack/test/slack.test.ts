import { describe, expect, it, vi } from "vitest";
import { FakeSlackClient } from "../src/client";
import { SlackDelivery } from "../src/delivery";
import { isThreadReply, parseAppMention, parseReactionFeedback, parseThreadReply } from "../src/parse";
import { computeSlackSignature, verifySlackSignature } from "../src/signature";

const SECRET = "test-signing-secret";

describe("verifySlackSignature", () => {
  const body = '{"type":"event_callback"}';
  const ts = "1700000000";
  const now = 1700000000 * 1000;

  it("accepts a valid signature", () => {
    const sig = computeSlackSignature(SECRET, ts, body);
    expect(verifySlackSignature(SECRET, ts, body, sig, now)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const sig = computeSlackSignature(SECRET, ts, body);
    expect(verifySlackSignature(SECRET, ts, body + "x", sig, now)).toBe(false);
  });
  it("rejects a stale timestamp (replay)", () => {
    const sig = computeSlackSignature(SECRET, ts, body);
    expect(verifySlackSignature(SECRET, ts, body, sig, now + 6 * 60 * 1000)).toBe(false);
  });
});

describe("parseAppMention", () => {
  const base = { type: "app_mention" as const, user: "U1", channel: "C1", ts: "111.1", team: "T1" };

  it("extracts a named agent after the bot mention", () => {
    const inv = parseAppMention(
      { ...base, text: "<@U0BOT> bruce why did checkout error?" },
      { knownAgents: ["bruce", "ada"], eventId: "Ev1" },
    );
    expect(inv.agentName).toBe("bruce");
    expect(inv.text).toBe("why did checkout error?");
    expect(inv.sourceRef).toMatchObject({ channel: "C1", thread_ts: "111.1", ts: "111.1", event_id: "Ev1" });
    expect(inv.userExternalId).toBe("U1");
  });

  it("uses the default agent (null) when the first word is not a known agent", () => {
    const inv = parseAppMention({ ...base, text: "<@U0BOT> summarize this thread" }, { knownAgents: ["bruce"] });
    expect(inv.agentName).toBeNull();
    expect(inv.text).toBe("summarize this thread");
  });

  it("carries the message's own ts distinct from thread_ts for an in-thread mention (§31.4)", () => {
    const inv = parseAppMention({ ...base, text: "<@U0BOT> what's up", thread_ts: "100.0" });
    expect(inv.sourceRef.ts).toBe("111.1");
    expect(inv.sourceRef.thread_ts).toBe("100.0");
    expect(inv.sourceRef.ts).not.toBe(inv.sourceRef.thread_ts);
  });
});

describe("parseReactionFeedback", () => {
  it("maps reactions to feedback types", () => {
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "+1" })?.feedbackType).toBe("thumbs_up");
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "thumbsdown" })?.feedbackType).toBe("thumbs_down");
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "eyes" })).toBeNull();
  });
});

describe("thread replies (Track 12)", () => {
  const reply = {
    type: "message" as const,
    user: "U1",
    channel: "C1",
    ts: "111.2",
    thread_ts: "111.1",
    text: "staging please",
    team: "T1",
  };

  it("isThreadReply accepts only plain human in-thread messages", () => {
    expect(isThreadReply(reply)).toBe(true);
    expect(isThreadReply({ ...reply, bot_id: "B1" })).toBe(false);
    expect(isThreadReply({ ...reply, subtype: "message_changed" })).toBe(false);
    expect(isThreadReply({ ...reply, thread_ts: undefined })).toBe(false);
    expect(isThreadReply({ ...reply, ts: "111.1" })).toBe(false); // the opener
    expect(isThreadReply({ ...reply, text: "<@U0BOT> more" })).toBe(false); // arrives as app_mention
    expect(isThreadReply({ ...reply, user: undefined })).toBe(false);
  });

  it("parseThreadReply anchors the invocation to its thread", () => {
    const inv = parseThreadReply(reply, { eventId: "Ev9" });
    expect(inv.sourceRef).toMatchObject({ channel: "C1", thread_ts: "111.1", ts: "111.2", event_id: "Ev9" });
    expect(inv.text).toBe("staging please");
    expect(inv.agentName).toBeNull();
    // The reply's own ts is distinct from the thread anchor (§31.4).
    expect(inv.sourceRef.ts).not.toBe(inv.sourceRef.thread_ts);
  });
});

describe("SlackDelivery.acknowledge (§31: ack via reaction, not text)", () => {
  it("reacts on the message's own ts, not the thread anchor", async () => {
    const client = new FakeSlackClient();
    const delivery = new SlackDelivery(client);

    await delivery.acknowledge({ channel: "C1", thread_ts: "100.0", ts: "111.2" });

    expect(client.reactions).toEqual([{ channel: "C1", ts: "111.2", reaction: "+1" }]);
  });

  it("falls back to thread_ts when ts is absent", async () => {
    const client = new FakeSlackClient();
    const delivery = new SlackDelivery(client);

    await delivery.acknowledge({ channel: "C1", thread_ts: "100.0" });

    expect(client.reactions).toEqual([{ channel: "C1", ts: "100.0", reaction: "+1" }]);
  });

  it("swallows a missing_scope error and logs a warning (§31.6/§31.8)", async () => {
    const client = new FakeSlackClient();
    client.reactionError = "missing_scope";
    const delivery = new SlackDelivery(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(delivery.acknowledge({ channel: "C1", ts: "111.2" })).resolves.toBeUndefined();

    expect(client.reactions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reactions:write");
    warn.mockRestore();
  });

  it("swallows any other reaction failure without logging the scope warning", async () => {
    const client = new FakeSlackClient();
    client.reactionError = "channel_not_found";
    const delivery = new SlackDelivery(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(delivery.acknowledge({ channel: "C1", ts: "111.2" })).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("SlackDelivery", () => {
  it("posts a threaded result via the client", async () => {
    const client = new FakeSlackClient();
    const delivery = new SlackDelivery(client);
    await delivery.deliverResult({ channel: "C1", thread_ts: "111.1" }, { summary: "done", costUsd: 0.01 });
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]?.channel).toBe("C1");
    expect(client.messages[0]?.threadTs).toBe("111.1");
    expect(client.messages[0]?.text).toContain("done");
  });

  it("loads fenced-ready thread context via fetchReplies (Track 12)", async () => {
    const client = new FakeSlackClient();
    client.threads.set("C1:111.1", [{ user: "U1", text: "why did checkout break?", ts: "111.1" }]);
    await client.postMessage("C1", "_on it…_", "111.1");
    const delivery = new SlackDelivery(client);

    const context = await delivery.loadContext({ channel: "C1", thread_ts: "111.1" });
    expect(context).toHaveLength(2);
    expect(context[0]).toMatchObject({ author: "U1", text: "why did checkout break?" });
    expect(context[1]?.text).toBe("_on it…_");
    // No thread anchor -> nothing to load.
    expect(await delivery.loadContext({ channel: "C1" })).toEqual([]);
  });
});
