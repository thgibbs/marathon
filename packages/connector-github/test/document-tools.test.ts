import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient, getRepoAccess } from "../src/client";
import { makeDocumentTools } from "../src/document-tools";

const ctx = { taskId: "t1", tenantId: "tn1", secrets: new EnvSecretStore({}) };
const tool = (name: string, gh: FixturesGithubClient) =>
  makeDocumentTools(() => gh).find((t) => t.name === name)!;

describe("document tools", () => {
  it("document.create opens a PR (branch + file + PR)", async () => {
    const gh = new FixturesGithubClient({});
    const res = await tool("document.create", gh).execute(
      { repo: "o/r", path: "docs/x.md", content: "# Hi" },
      ctx,
    );
    expect(res.content).toMatch(/opened PR #\d+/);
    const ops = gh.writes.map((w) => w.op);
    expect(ops).toContain("createBranch");
    expect(ops).toContain("putFile");
    expect(ops).toContain("createPullRequest");
  });

  it("document.update rejects a stale SHA", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    await expect(
      tool("document.update", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v2", sha: "stale" }, ctx),
    ).rejects.toThrow(/stale|409/);
  });

  it("document.read_region slices lines", async () => {
    const gh = new FixturesGithubClient({ files: { "o/r:docs/x.md": { path: "docs/x.md", content: "a\nb\nc\nd" } } });
    const res = await tool("document.read_region", gh).execute(
      { repo: "o/r", path: "docs/x.md", startLine: 2, endLine: 3 },
      ctx,
    );
    expect(res.content).toBe("b\nc");
  });

  it("document.create renders into a template when requested", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute(
      { repo: "o/r", path: "docs/pm.md", content: "It broke.", template: "postmortem" },
      ctx,
    );
    const put = gh.writes.find((w) => w.op === "putFile") as { args: { content: string } };
    expect(put.args.content).toContain("## Root cause");
    expect(put.args.content).toContain("It broke.");
  });

  it("document.revise commits to an existing branch (no new PR)", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    const branch = (gh.writes.find((w) => w.op === "createBranch")!.args as { branch: string }).branch;
    const puts = gh.writes.filter((w) => w.op === "putFile").length;
    const res = await tool("document.revise", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v2", branch }, ctx);
    expect(res.content).toMatch(/revised/);
    expect(gh.writes.filter((w) => w.op === "createPullRequest")).toHaveLength(1); // no new PR
    expect(gh.writes.filter((w) => w.op === "putFile")).toHaveLength(puts + 1);
  });

  it("document.reply_to_comment threads under a review comment", async () => {
    const gh = new FixturesGithubClient({});
    const res = await tool("document.reply_to_comment", gh).execute(
      { repo: "o/r", number: 7, commentId: 99, body: "thanks" },
      ctx,
    );
    expect(res.content).toMatch(/replied/);
    expect(gh.writes.some((w) => w.op === "replyToReviewComment")).toBe(true);
  });
});

describe("getRepoAccess", () => {
  it("allows when agent can see the repo and the user has access", async () => {
    const gh = new FixturesGithubClient({ userPermissions: { "o/r:alice": "write" } });
    const a = await getRepoAccess(gh, "o/r", "alice");
    expect(a).toEqual({ agentOk: true, userOk: true, userPermission: "write" });
  });

  it("denies a user without access", async () => {
    const gh = new FixturesGithubClient({ userPermissions: { "o/r:stranger": "none" } });
    const a = await getRepoAccess(gh, "o/r", "stranger");
    expect(a.userOk).toBe(false);
  });

  it("denies when the agent token cannot see the repo", async () => {
    const gh = new FixturesGithubClient({ repos: { "o/secret": { botAccess: false } } });
    const a = await getRepoAccess(gh, "o/secret", "alice");
    expect(a).toEqual({ agentOk: false, userOk: false, userPermission: "none" });
  });
});
