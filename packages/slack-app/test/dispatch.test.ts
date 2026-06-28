import { describe, expect, it } from "vitest";
import { classifyEnvelope } from "../src/handlers";

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
});
