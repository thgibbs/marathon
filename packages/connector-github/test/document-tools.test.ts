import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
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
});
