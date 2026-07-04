import { describe, expect, it } from "vitest";
import { classifyEnvelope, isStatusAsk } from "../src/handlers";

describe("classifyEnvelope", () => {
  it("classifies an app_mention", () => {
    const action = classifyEnvelope({
      type: "events_api",
      envelope_id: "e1",
      payload: { event_id: "Ev1", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@U0> hi" } },
    });
    expect(action.kind).toBe("mention");
    if (action.kind === "mention") {
      expect(action.eventId).toBe("Ev1");
      expect(action.event.channel).toBe("C1");
    }
  });

  it("classifies a reaction_added", () => {
    const action = classifyEnvelope({
      type: "events_api",
      payload: { event: { type: "reaction_added", user: "U1", reaction: "+1" } },
    });
    expect(action.kind).toBe("reaction");
  });

  it("ignores non-events_api or unknown events", () => {
    expect(classifyEnvelope({ type: "interactive", payload: {} }).kind).toBe("ignore");
    expect(classifyEnvelope({ type: "events_api", payload: { event: { type: "message" } } }).kind).toBe("ignore");
    expect(classifyEnvelope({ type: "events_api", payload: {} }).kind).toBe("ignore");
  });

  it("classifies a plain human thread reply (Track 12)", () => {
    const reply = (event: Record<string, unknown>) =>
      classifyEnvelope({ type: "events_api", payload: { event_id: "Ev2", event } });
    const base = { type: "message", user: "U1", channel: "C1", ts: "1.2", thread_ts: "1.1", text: "staging" };

    const action = reply(base);
    expect(action.kind).toBe("reply");
    if (action.kind === "reply") expect(action.eventId).toBe("Ev2");

    // Not replies: bot posts, subtypes, thread openers, mentions, non-threaded.
    expect(reply({ ...base, bot_id: "B1" }).kind).toBe("ignore");
    expect(reply({ ...base, subtype: "message_changed" }).kind).toBe("ignore");
    expect(reply({ ...base, ts: "1.1" }).kind).toBe("ignore"); // opener
    expect(reply({ ...base, text: "<@U0BOT> do more" }).kind).toBe("ignore"); // arrives as app_mention
    expect(reply({ ...base, thread_ts: undefined }).kind).toBe("ignore");
    expect(reply({ ...base, text: "  " }).kind).toBe("ignore");
  });
});

describe("isStatusAsk (Track 16, §15.3)", () => {
  it("matches a bare status ask, case- and whitespace-insensitively", () => {
    expect(isStatusAsk("status")).toBe(true);
    expect(isStatusAsk("  Status ")).toBe(true);
    expect(isStatusAsk("STATUS")).toBe(true);
  });

  it("does not swallow real work that merely mentions status", () => {
    expect(isStatusAsk("what's the status of the rollout?")).toBe(false);
    expect(isStatusAsk("status page is down")).toBe(false);
    expect(isStatusAsk("")).toBe(false);
  });
});
