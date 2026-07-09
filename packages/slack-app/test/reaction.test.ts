import type { SlackReactionEvent } from "@marathon/surface-slack";
import { describe, expect, it } from "vitest";
import { handleReaction, type AppDeps } from "../src/handlers";

/**
 * §31.7 — acknowledge() now reacts :+1: on the triggering message. That would
 * otherwise be misread as feedback two ways; both checks are needed
 * independently (neither subsumes the other).
 */

const TENANT = "tn1";
const BOT_USER = "UBOT";

function makeDeps(opts: { isOutputMessage?: boolean; botUserId?: string } = {}) {
  const recorded: Array<{ userId: string; feedbackType: string }> = [];
  const deps = {
    tenantId: TENANT,
    botUserId: opts.botUserId ?? BOT_USER,
    db: {
      isSlackOutputMessage: async () => opts.isOutputMessage ?? false,
      findOrCreateUserByIdentity: async (_tenantId: string, _surface: string, externalId: string) => ({
        id: `user-${externalId}`,
      }),
      recordFeedback: async (input: { userId: string; feedbackType: string }) =>
        void recorded.push({ userId: input.userId, feedbackType: input.feedbackType }),
    },
  } as never as AppDeps;
  return { deps, recorded };
}

const reactionEvent = (overrides: Partial<SlackReactionEvent> = {}): SlackReactionEvent => ({
  type: "reaction_added",
  user: "U1",
  reaction: "+1",
  item: { channel: "C1", ts: "111.1" },
  ...overrides,
});

describe("handleReaction (§31.7 self-feedback bug fix)", () => {
  it("does not record feedback for the bot's own ack reaction, even on a known output message", async () => {
    const { deps, recorded } = makeDeps({ isOutputMessage: true });
    await handleReaction(deps, reactionEvent({ user: BOT_USER }));
    expect(recorded).toEqual([]);
  });

  it("records feedback for a genuine user reaction on a Marathon-authored output message", async () => {
    const { deps, recorded } = makeDeps({ isOutputMessage: true });
    await handleReaction(deps, reactionEvent({ user: "U1" }));
    expect(recorded).toEqual([{ userId: "user-U1", feedbackType: "thumbs_up" }]);
  });

  it("does not record feedback for a genuine user reacting on the triggering/input message", async () => {
    const { deps, recorded } = makeDeps({ isOutputMessage: false });
    await handleReaction(deps, reactionEvent({ user: "U1" }));
    expect(recorded).toEqual([]);
  });

  /**
   * Review follow-up: excluding only the known trigger ts still let a :+1: on
   * an unrelated channel message, or a task input that hasn't been persisted
   * yet, fall through as feedback. The allow-list check must reject both the
   * same way it rejects the triggering message — there is no "unknown, so
   * assume it's output" branch.
   */
  it("does not record feedback for a reaction on a message Marathon never posted (unrelated or not-yet-persisted)", async () => {
    const { deps, recorded } = makeDeps({ isOutputMessage: false });
    await handleReaction(deps, reactionEvent({ user: "U1", item: { channel: "C1", ts: "999.9" } }));
    expect(recorded).toEqual([]);
  });
});
