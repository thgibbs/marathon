import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient, getRepoAccess } from "../src/client";
import { docBranchForTask, makeDocumentTools } from "../src/document-tools";

const ctx = { taskId: "t1", tenantId: "tn1", secrets: new EnvSecretStore({}) };
const tool = (name: string, gh: FixturesGithubClient) =>
  makeDocumentTools(() => gh).find((t) => t.name === name)!;

describe("document tools", () => {
  it("a configured docBase (the default branch, §29.1a) is authoritative over model input", async () => {
    const gh = new FixturesGithubClient({});
    const create = makeDocumentTools(() => gh, { docBase: "main" }).find((t) => t.name === "document.create")!;
    // The model tries to retarget the doc PR at another branch — the config wins.
    await create.execute({ repo: "o/r", path: "docs/x.md", content: "# Hi", base: "some-branch" }, ctx);
    const pr = gh.writes.find((w) => w.op === "createPullRequest")!;
    expect((pr.args as { base: string }).base).toBe("main");
  });

  it("document.create opens a DRAFT PR against the default branch (§29.1a combined-PR flow)", async () => {
    const gh = new FixturesGithubClient({});
    const create = makeDocumentTools(() => gh, { docBase: "main" }).find((t) => t.name === "document.create")!;
    await create.execute({ repo: "o/r", path: "docs/x.md", content: "# Hi" }, ctx);
    const pr = gh.writes.find((w) => w.op === "createPullRequest")!.args as { base: string; draft: boolean; body?: string };
    expect(pr.base).toBe("main");
    expect(pr.draft).toBe(true);
    // The body tells the reviewer how to approve in the combined-PR flow.
    expect(pr.body).toContain("approving review");
  });

  it("onDocumentPr fires with the PR info — on creation AND on a converged retry (§29.1a)", async () => {
    const gh = new FixturesGithubClient({});
    const events: Array<Record<string, unknown>> = [];
    const create = makeDocumentTools(() => gh, {
      docBase: "main",
      onDocumentPr: (ev) => void events.push(ev as never),
    }).find((t) => t.name === "document.create")!;

    await create.execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "t1",
      tenantId: "tn1",
      repo: "o/r",
      path: "docs/x.md",
      prNumber: 1,
      converged: false,
    });

    // A webhook/agent retry converges on the same PR — the hook still fires
    // (the recorder is idempotent), so a lost first recording is repaired.
    await create.execute({ repo: "o/r", path: "docs/x.md", content: "# v1 retried" }, ctx);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ prNumber: 1, converged: true });
  });

  it("without a configured docBase, input.base is honored (default 'main')", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# Hi", base: "develop" }, ctx);
    const pr = gh.writes.find((w) => w.op === "createPullRequest")!;
    expect((pr.args as { base: string }).base).toBe("develop");
  });

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

  it("document.create branches deterministically per (task, path) — no timestamps (Track 10)", async () => {
    const gh = new FixturesGithubClient({});
    const res = await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# Hi" }, ctx);
    expect((res.details as { branch: string }).branch).toBe(docBranchForTask("t1", "docs/x.md"));
    expect(docBranchForTask("t1", "docs/x.md")).toBe("marathon/doc-t1-docs-x-md");
    // Distinct tasks writing the same path never collide.
    expect(docBranchForTask("t2", "docs/x.md")).not.toBe(docBranchForTask("t1", "docs/x.md"));
  });

  it("document.create converges on the existing branch/PR under a webhook retry (Track 10)", async () => {
    const gh = new FixturesGithubClient({});
    const first = await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    const again = await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1 retried" }, ctx);
    const firstDetails = first.details as { number: number; converged: boolean };
    const againDetails = again.details as { number: number; converged: boolean };
    expect(firstDetails.converged).toBe(false);
    expect(againDetails.converged).toBe(true);
    expect(againDetails.number).toBe(firstDetails.number); // same PR
    expect(gh.writes.filter((w) => w.op === "createPullRequest")).toHaveLength(1);
    expect(gh.writes.filter((w) => w.op === "createBranch")).toHaveLength(1);
  });

  it("document.update rejects a stale SHA", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    await expect(
      tool("document.update", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v2", sha: "stale" }, ctx),
    ).rejects.toThrow(/stale|409/);
  });

  it("document.update converges under a retry — replay is a no-op, not a stale-SHA failure (Track 10)", async () => {
    const gh = new FixturesGithubClient({});
    await tool("document.create", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v1" }, ctx);
    const { sha } = await gh.readFileWithSha("o/r", "docs/x.md");

    const first = await tool("document.update", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v2", sha }, ctx);
    const putsAfterFirst = gh.writes.filter((w) => w.op === "putFile").length;

    // The webhook/tool retry replays the SAME accepted update: the branch has
    // moved past the caller's sha, but this must converge, not 409.
    const retry = await tool("document.update", gh).execute({ repo: "o/r", path: "docs/x.md", content: "# v2", sha }, ctx);
    expect((retry.details as { converged: boolean }).converged).toBe(true);
    expect((retry.details as { number: number }).number).toBe((first.details as { number: number }).number);
    expect(gh.writes.filter((w) => w.op === "putFile")).toHaveLength(putsAfterFirst); // no-op: nothing re-committed
    expect(gh.writes.filter((w) => w.op === "createPullRequest")).toHaveLength(1);
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

  it("document.revise rebases (re-reads + retries) once on a conflict", async () => {
    let sha = "sha-1";
    let puts = 0;
    const stub = {
      async readFileWithSha() {
        return { path: "docs/x.md", content: "cur", sha };
      },
      async putFile(_r: string, _p: string, _c: string, _b: string, _m: string, withSha?: string) {
        puts++;
        if (withSha === "sha-1") {
          sha = "sha-2"; // a concurrent edit moved it
          throw new Error("github 409: file changed (stale sha)");
        }
        return { commitSha: "c", contentSha: sha };
      },
    } as unknown as FixturesGithubClient;
    const tools = makeDocumentTools(() => stub);
    const res = await tools.find((t) => t.name === "document.revise")!.execute(
      { repo: "o/r", path: "docs/x.md", content: "# v2", branch: "marathon/doc-x" },
      ctx,
    );
    expect(puts).toBe(2); // first 409, retried once with the fresh sha
    expect((res.details as { rebased: boolean }).rebased).toBe(true);
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
