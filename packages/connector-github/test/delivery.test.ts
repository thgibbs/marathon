import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { GithubDelivery } from "../src/delivery";

describe("GithubDelivery.acknowledge (§31: ack via reaction, not text)", () => {
  it("reacts on an issue/PR-conversation comment via the issue-comment endpoint", async () => {
    const client = new FixturesGithubClient({});
    const delivery = new GithubDelivery(client);

    await delivery.acknowledge({ repo: "o/r", number: 7, commentId: 99, commentType: "issue" });

    expect(client.reactions).toEqual([{ repo: "o/r", commentId: 99, commentType: "issue", reaction: "+1" }]);
  });

  it("reacts on a PR review (diff-inline) comment via the review-comment endpoint", async () => {
    const client = new FixturesGithubClient({});
    const delivery = new GithubDelivery(client);

    await delivery.acknowledge({ repo: "o/r", number: 7, commentId: 5, commentType: "review" });

    expect(client.reactions).toEqual([{ repo: "o/r", commentId: 5, commentType: "review", reaction: "+1" }]);
  });

  it("is a no-op when the ref carries no comment identity", async () => {
    const client = new FixturesGithubClient({});
    const delivery = new GithubDelivery(client);

    await delivery.acknowledge({ repo: "o/r", number: 7 });

    expect(client.reactions).toEqual([]);
  });

  it("swallows a reaction failure (§31.8) — never fails the task", async () => {
    const client = new FixturesGithubClient({});
    client.addIssueCommentReaction = async () => {
      throw new Error("github 404: comment not found");
    };
    const delivery = new GithubDelivery(client);

    await expect(delivery.acknowledge({ repo: "o/r", number: 7, commentId: 99, commentType: "issue" })).resolves.toBeUndefined();
  });
});

describe("GithubDelivery.loadContext (Track 12, §7.18)", () => {
  it("returns the issue/PR comment history, ready to fence", async () => {
    const client = new FixturesGithubClient({});
    client.issueComments.push({ key: "o/r:7", id: 1, author: "alice", body: "please add rate limiting" });
    await client.commentIssue("o/r", 7, "_on it…_");
    const delivery = new GithubDelivery(client);

    const context = await delivery.loadContext({ repo: "o/r", number: 7 });
    expect(context).toHaveLength(2);
    expect(context[0]).toMatchObject({ author: "alice", text: "please add rate limiting" });
    expect(context[1]).toMatchObject({ author: "marathon[bot]", text: "_on it…_" });
    // Other issues' comments are not included.
    expect(await delivery.loadContext({ repo: "o/r", number: 8 })).toEqual([]);
  });
});
