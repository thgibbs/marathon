import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { makeGithubReadTools } from "../src/tools";

const client = new FixturesGithubClient({
  files: { "o/repo:README.md": { path: "README.md", content: "# Hello\n" } },
  contents: {
    "o/repo:": [
      { name: "README.md", type: "file", path: "README.md" },
      { name: "src", type: "dir", path: "src" },
    ],
  },
});

const tools = makeGithubReadTools(() => client);
const readFile = tools.find((t) => t.name === "github.read_file")!;
const listContents = tools.find((t) => t.name === "github.list_contents")!;
const ctx = { taskId: "t1", tenantId: "tn1", secrets: new EnvSecretStore({}) };

describe("github read tools", () => {
  it("validates required args", () => {
    expect(readFile.validate?.({})).toMatch(/repo/);
    expect(readFile.validate?.({ repo: "o/repo" })).toMatch(/path/);
    expect(readFile.validate?.({ repo: "o/repo", path: "README.md" })).toBeNull();
  });

  it("reads a file via the client", async () => {
    const res = await readFile.execute({ repo: "o/repo", path: "README.md" }, ctx);
    expect(res.content).toContain("# Hello");
  });

  it("lists directory contents", async () => {
    const res = await listContents.execute({ repo: "o/repo" }, ctx);
    expect(res.content).toContain("file\tREADME.md");
    expect(res.content).toContain("dir\tsrc");
  });

  it("tools are read-only (reversible, autonomous) and declare their source", () => {
    for (const t of tools) {
      expect(t.riskAxes.reversible).toBe(true);
      expect(t.defaultMode).toBe("autonomous");
      expect(t.sources?.({ repo: "o/repo" })).toEqual([
        { source: "github:o/repo", sensitivity: "company_viewable" },
      ]);
    }
  });
});
