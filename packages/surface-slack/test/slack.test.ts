import { describe, expect, it } from "vitest";
import { FakeSlackClient } from "../src/client";
import { SlackDelivery } from "../src/delivery";
import { parseAppMention, parseReactionFeedback } from "../src/parse";
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
    expect(inv.sourceRef).toMatchObject({ channel: "C1", thread_ts: "111.1", event_id: "Ev1" });
    expect(inv.userExternalId).toBe("U1");
  });

  it("uses the default agent (null) when the first word is not a known agent", () => {
    const inv = parseAppMention({ ...base, text: "<@U0BOT> summarize this thread" }, { knownAgents: ["bruce"] });
    expect(inv.agentName).toBeNull();
    expect(inv.text).toBe("summarize this thread");
  });
});

describe("parseReactionFeedback", () => {
  it("maps reactions to feedback types", () => {
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "+1" })?.feedbackType).toBe("thumbs_up");
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "thumbsdown" })?.feedbackType).toBe("thumbs_down");
    expect(parseReactionFeedback({ type: "reaction_added", user: "U1", reaction: "eyes" })).toBeNull();
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
});
