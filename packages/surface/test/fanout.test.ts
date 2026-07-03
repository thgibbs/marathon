import { InMemoryIdempotencyStore, type DeliveryTarget } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { DeliveryFanout, describeTarget } from "../src/fanout";
import type { StructuredResult, SurfaceAdapter } from "../src/types";

type Sent = { kind: "progress" | "result"; ref: Record<string, unknown>; message?: string; result?: StructuredResult };

function makeAdapter(sent: Sent[]): SurfaceAdapter {
  return {
    acknowledge: async () => {},
    postProgress: async (ref, message) => void sent.push({ kind: "progress", ref, message }),
    deliverResult: async (ref, result) => void sent.push({ kind: "result", ref, result }),
  };
}

const slackTarget: DeliveryTarget = { surfaceType: "slack", ref: { channel: "C1", thread_ts: "1.1" } };
const docPrTarget: DeliveryTarget = { surfaceType: "github", ref: { repo: "o/r", number: 7, kind: "pr" } };

describe("DeliveryFanout", () => {
  it("delivers a result to every target across surfaces", async () => {
    const slackSent: Sent[] = [];
    const githubSent: Sent[] = [];
    const fanout = new DeliveryFanout(
      { slack: makeAdapter(slackSent), github: makeAdapter(githubSent) },
      new InMemoryIdempotencyStore(),
    );
    const outcomes = await fanout.deliverResult("t1", [slackTarget, docPrTarget], { summary: "done" });
    expect(outcomes.map((o) => o.status)).toEqual(["delivered", "delivered"]);
    expect(slackSent).toHaveLength(1);
    expect(githubSent).toHaveLength(1);
    expect(githubSent[0]?.ref).toEqual(docPrTarget.ref);
  });

  it("is idempotent per (task, target, message kind)", async () => {
    const sent: Sent[] = [];
    const fanout = new DeliveryFanout({ slack: makeAdapter(sent) }, new InMemoryIdempotencyStore());
    await fanout.postProgress("t1", [slackTarget], "working…", "step_1");
    const again = await fanout.postProgress("t1", [slackTarget], "working…", "step_1");
    expect(again[0]?.status).toBe("deduped");
    expect(sent).toHaveLength(1);

    // a different kind (or task) delivers fresh
    const other = await fanout.postProgress("t1", [slackTarget], "still working…", "step_2");
    expect(other[0]?.status).toBe("delivered");
    expect(sent).toHaveLength(2);
  });

  it("skips targets whose surface has no adapter", async () => {
    const sent: Sent[] = [];
    const fanout = new DeliveryFanout({ github: makeAdapter(sent) }, new InMemoryIdempotencyStore());
    const outcomes = await fanout.deliverResult("t1", [slackTarget, docPrTarget], { summary: "done" });
    expect(outcomes.find((o) => o.target === slackTarget)?.status).toBe("no_adapter");
    expect(sent).toHaveLength(1);
  });

  it("releases the claim when a send fails, so a retry can deliver", async () => {
    let calls = 0;
    const adapter: SurfaceAdapter = {
      acknowledge: async () => {},
      postProgress: async () => {},
      deliverResult: async () => {
        calls++;
        if (calls === 1) throw new Error("slack down");
      },
    };
    const fanout = new DeliveryFanout({ slack: adapter }, new InMemoryIdempotencyStore());
    await expect(fanout.deliverResult("t1", [slackTarget], { summary: "x" })).rejects.toThrow("slack down");
    const retry = await fanout.deliverResult("t1", [slackTarget], { summary: "x" });
    expect(retry[0]?.status).toBe("delivered");
    expect(calls).toBe(2);
  });

  it("cross-links the other targets on multi-target results", async () => {
    const slackSent: Sent[] = [];
    const githubSent: Sent[] = [];
    const fanout = new DeliveryFanout(
      { slack: makeAdapter(slackSent), github: makeAdapter(githubSent) },
      new InMemoryIdempotencyStore(),
    );
    await fanout.deliverResult("t1", [slackTarget, docPrTarget], { summary: "done" });
    expect(slackSent[0]?.result?.crossLinks).toEqual(["https://github.com/o/r/pull/7"]);
    expect(githubSent[0]?.result?.crossLinks).toEqual([describeTarget(slackTarget)]);
    // single-target delivery carries no cross-links
    const solo: Sent[] = [];
    const soloFanout = new DeliveryFanout({ slack: makeAdapter(solo) }, new InMemoryIdempotencyStore());
    await soloFanout.deliverResult("t2", [slackTarget], { summary: "done" });
    expect(solo[0]?.result?.crossLinks).toBeUndefined();
  });
});

describe("describeTarget", () => {
  it("renders GitHub PRs, issues, Slack threads, and a generic fallback", () => {
    expect(describeTarget(docPrTarget)).toBe("https://github.com/o/r/pull/7");
    expect(describeTarget({ surfaceType: "github", ref: { repo: "o/r", number: 3, kind: "issue" } })).toBe(
      "https://github.com/o/r/issues/3",
    );
    expect(describeTarget(slackTarget)).toBe("Slack channel C1, thread 1.1");
    expect(describeTarget({ surfaceType: "slack", ref: { channel: "C2" } })).toBe("Slack channel C2");
    expect(describeTarget({ surfaceType: "web", ref: { url: "u" } })).toBe('web {"url":"u"}');
  });
});
