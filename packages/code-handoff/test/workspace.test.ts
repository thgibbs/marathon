import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeWorkspace } from "../src/workspace";

const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout;
}

/** A local fixture repo with two commits, standing in for the configured repo. */
let originDir: string;
let baseSha: string;
let headSha: string;

beforeAll(async () => {
  originDir = await mkdtemp(join(tmpdir(), "marathon-fixture-"));
  await execFileAsync("git", ["init", "--quiet", originDir]);
  await git(originDir, "config", "user.name", "Fixture");
  await git(originDir, "config", "user.email", "fixture@test");
  await writeFile(join(originDir, "README.md"), "# fixture\n");
  await writeFile(join(originDir, "app.ts"), "export const x = 1;\n");
  await git(originDir, "add", "-A");
  await git(originDir, "commit", "--quiet", "-m", "init");
  baseSha = (await git(originDir, "rev-parse", "HEAD")).trim();
  await writeFile(join(originDir, "later.txt"), "after the pin\n");
  await git(originDir, "add", "-A");
  await git(originDir, "commit", "--quiet", "-m", "later");
  headSha = (await git(originDir, "rev-parse", "HEAD")).trim();
});

afterAll(async () => {
  await execFileAsync("rm", ["-rf", originDir]);
});

describe("CodeWorkspace.materialize", () => {
  it("clones detached at base_sha — the merged plan's commit, not the moving head", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      const head = (await git(ws.dir, "rev-parse", "HEAD")).trim();
      expect(head).toBe(baseSha);
      expect(head).not.toBe(headSha);
      expect(existsSync(ws.path("later.txt"))).toBe(false);
    } finally {
      await ws.dispose();
    }
  });

  it("strips remotes and credential helpers before the sandbox mount", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      expect(await ws.remotes()).toEqual([]);
      // Only the shadowing empty helper remains — no real helper survives.
      expect((await ws.credentialHelpers()).filter(Boolean)).toEqual([]);
    } finally {
      await ws.dispose();
    }
  });

  it("dispose destroys the workspace", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });
});

describe("diff capture and tree hash", () => {
  it("captures edits, new files, and deletions relative to base_sha", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      expect((await ws.captureDiff()).trim()).toBe("");

      await ws.writeFile("app.ts", "export const x = 2;\n");
      await ws.writeFile("src/new.ts", "export const y = 3;\n");
      await ws.deleteFile("README.md");

      const diff = await ws.captureDiff();
      expect(diff).toContain("export const x = 2;");
      expect(diff).toContain("src/new.ts");
      expect(diff).toContain("deleted file");
      expect((await ws.changedFiles()).sort()).toEqual(["README.md", "app.ts", "src/new.ts"]);
    } finally {
      await ws.dispose();
    }
  });

  it("a pure rename lists BOTH paths (no rename coalescing — the commit builder needs the deletion)", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      // Identical content — exactly the case git's rename detection would
      // otherwise collapse to a single "new path" entry.
      const content = await ws.readFile("app.ts");
      await ws.writeFile("core.ts", content);
      await ws.deleteFile("app.ts");

      expect((await ws.changedFiles()).sort()).toEqual(["app.ts", "core.ts"]);
      const diff = await ws.captureDiff();
      expect(diff).toContain("deleted file");
      expect(diff).not.toContain("rename from");
    } finally {
      await ws.dispose();
    }
  });

  it("tree hash is stable for the same tree and changes with the tree", async () => {
    const ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      const clean = await ws.treeHash();
      expect(await ws.treeHash()).toBe(clean);
      await ws.writeFile("app.ts", "export const x = 2;\n");
      expect(await ws.treeHash()).not.toBe(clean);
    } finally {
      await ws.dispose();
    }
  });

  it("snapshot/replay: applying a captured diff to a fresh clone converges on the same tree (K4)", async () => {
    const a = await CodeWorkspace.materialize({ source: originDir, baseSha });
    const b = await CodeWorkspace.materialize({ source: originDir, baseSha });
    try {
      await a.writeFile("app.ts", "export const x = 42;\n");
      await a.writeFile("src/new.ts", "export const y = 3;\n");
      await a.deleteFile("README.md");
      const snapshot = await a.captureDiff();

      await b.applyDiff(snapshot);
      expect(await b.treeHash()).toBe(await a.treeHash());
      expect(await b.readFile("app.ts")).toBe("export const x = 42;\n");
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
