import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { GithubDelivery } from "../src/delivery";

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
