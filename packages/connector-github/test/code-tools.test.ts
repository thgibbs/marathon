import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CodeTaskRegistry,
  CodeWorkspace,
  InMemoryCodeChangeStore,
} from "@marathon/code-handoff";
import type { PlanRef } from "@marathon/core";
import { InMemorySourceLedger, ToolBlockedError, ToolGateway, ToolRegistry, type ToolInput } from "@marathon/tools";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { makeGithubCodeTools } from "../src/code-tools";

const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout;
}

const REPO = "acme/service";
const TASK_ID = "task-42";
let originDir: string;
let baseSha: string;
let planRef: PlanRef;

beforeAll(async () => {
  originDir = await mkdtemp(join(tmpdir(), "marathon-code-fixture-"));
  await execFileAsync("git", ["init", "--quiet", originDir]);
  await git(originDir, "config", "user.name", "Fixture");
  await git(originDir, "config", "user.email", "fixture@test");
  await writeFile(join(originDir, "app.ts"), "export const x = 1;\n");
  await git(originDir, "add", "-A");
  await git(originDir, "commit", "--quiet", "-m", "init");
  baseSha = (await git(originDir, "rev-parse", "HEAD")).trim();
  planRef = { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: baseSha };
});

afterAll(async () => {
  await execFileAsync("rm", ["-rf", originDir]);
});

let ws: CodeWorkspace;
let client: FixturesGithubClient;
let store: InMemoryCodeChangeStore;
let gateway: ToolGateway;

beforeEach(async () => {
  ws = await CodeWorkspace.materialize({ source: originDir, baseSha });
  client = new FixturesGithubClient({});
  store = new InMemoryCodeChangeStore();
  const registry = new CodeTaskRegistry();
  registry.set(TASK_ID, { workspace: ws, planRef, repo: REPO, baseSha });
  const tools = makeGithubCodeTools({ getClient: () => client, registry, store });
  gateway = new ToolGateway({
    registry: new ToolRegistry(tools),
    policy: { grants: [{ tool: "github.submit_code_changes" }] },
    secrets: { get: async () => null } as never,
  });
});

afterEach(async () => {
  await ws.dispose();
});

const GREEN = [{ command: "pnpm test", exit_code: 0, summary: "42 passed" }];
const RED = [{ command: "pnpm test", exit_code: 1, summary: "2 failed" }];

function submit(overrides: ToolInput = {}) {
  return gateway.run(
    "github.submit_code_changes",
    {
      title: "Add retry logic",
      summary: "Implements the retry plan.",
      plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: baseSha },
      verification: GREEN,
      ...overrides,
    },
    { taskId: TASK_ID, tenantId: "tenant-1" },
  );
}

describe("github.submit_code_changes — happy path (§29.4)", () => {
  it("commits the workspace diff, pushes marathon/<task>-<slug>, opens a ready PR, records CodeChange", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const res = await submit();
    const details = res.details as Record<string, unknown>;

    expect(details.branch).toBe("marathon/task-42-add-retry-logic");
    expect(details.state).toBe("submitted_ready");
    expect(details.verified).toBe(true);

    // Bot-authored commit with the plan reference and Marathon-Task trailer.
    const commit = client.writes.find((w) => w.op === "createCommit");
    const msg = (commit?.args as { message: string }).message;
    expect(msg).toContain("Marathon-Task: task-42");
    expect(msg).toContain("docs/plan.md");

    // PR body carries plan link + verification (§29.5).
    const pr = client.writes.find((w) => w.op === "createPullRequest");
    const prArgs = pr?.args as { body: string; draft: boolean; base: string };
    expect(prArgs.draft).toBe(false);
    expect(prArgs.body).toContain("docs/plan.md");
    expect(prArgs.body).toContain("pnpm test");

    const change = await store.getCodeChangeByTask(TASK_ID);
    expect(change?.state).toBe("submitted_ready");
    expect(change?.prNumber).toBe(details.pr_number);
    expect(change?.treeHash).toBe(details.tree_hash);
    expect(change?.verification).toEqual([{ command: "pnpm test", exitCode: 0, summary: "42 passed" }]);
  });

  it("red verification forces a draft PR labeled marathon:unverified (§29.3)", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const res = await submit({ verification: RED });
    const details = res.details as Record<string, unknown>;

    expect(details.state).toBe("submitted_draft");
    const pr = client.writes.find((w) => w.op === "createPullRequest");
    expect((pr?.args as { draft: boolean }).draft).toBe(true);
    expect(client.labels.get(`${REPO}:${details.pr_number}`)).toContain("marathon:unverified");
    expect((pr?.args as { body: string }).body).toContain("not green");
  });

  it("resubmitting the same tree is a no-op returning the same PR (§29.4 idempotency)", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const first = await submit();
    const writesAfterFirst = client.writes.length;

    const second = await submit();
    expect((second.details as { noop?: boolean }).noop).toBe(true);
    expect((second.details as { pr_url: string }).pr_url).toBe((first.details as { pr_url: string }).pr_url);
    expect(client.writes.length).toBe(writesAfterFirst); // no new git/PR writes
  });

  it("a changed tree updates the same branch and PR instead of opening a new one (§29.5)", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const first = await submit();
    await ws.writeFile("app.ts", "export const x = 3;\n");
    const second = await submit({ title: "Add retry logic v2" });

    const d1 = first.details as Record<string, unknown>;
    const d2 = second.details as Record<string, unknown>;
    expect(d2.branch).toBe(d1.branch); // branch fixed by the CodeChange record
    expect(d2.pr_number).toBe(d1.pr_number);
    expect(d2.updated).toBe(true);
    expect(client.writes.filter((w) => w.op === "createPullRequest")).toHaveLength(1);
    expect(client.writes.some((w) => w.op === "updateRef" && (w.args as { force: boolean }).force)).toBe(true);
  });

  it("a red draft that turns green becomes a ready PR without the unverified label (§29.3)", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const red = await submit({ verification: RED });
    const prNumber = (red.details as { pr_number: number }).pr_number;
    expect(client.openPrs.get(`${REPO}:marathon/task-42-add-retry-logic`)?.draft).toBe(true);
    expect(client.labels.get(`${REPO}:${prNumber}`)).toContain("marathon:unverified");

    await ws.writeFile("app.ts", "export const x = 3;\n"); // new tree, now green
    const green = await submit();
    expect((green.details as { pr_number: number }).pr_number).toBe(prNumber);
    expect((green.details as { state: string }).state).toBe("submitted_ready");
    expect(client.openPrs.get(`${REPO}:marathon/task-42-add-retry-logic`)?.draft).toBe(false);
    expect(client.labels.get(`${REPO}:${prNumber}`)).not.toContain("marathon:unverified");
    expect(client.writes.some((w) => w.op === "setPullRequestDraft" && (w.args as { draft: boolean }).draft === false)).toBe(true);
  });

  it("a green PR whose revision turns red re-drafts and re-labels (§29.3)", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const first = await submit();
    const prNumber = (first.details as { pr_number: number }).pr_number;
    expect(client.openPrs.get(`${REPO}:marathon/task-42-add-retry-logic`)?.draft).toBe(false);

    await ws.writeFile("app.ts", "export const x = 3;\n");
    const red = await submit({ verification: RED });
    expect((red.details as { state: string }).state).toBe("submitted_draft");
    expect(client.openPrs.get(`${REPO}:marathon/task-42-add-retry-logic`)?.draft).toBe(true);
    expect(client.labels.get(`${REPO}:${prNumber}`)).toContain("marathon:unverified");
  });

  it("a rename reaches the commit as delete(old) + add(new) — no stale copy left behind (§29 tree fidelity)", async () => {
    const content = await ws.readFile("app.ts");
    await ws.writeFile("core.ts", content);
    await ws.deleteFile("app.ts");
    await submit();

    const tree = client.writes.find((w) => w.op === "createTree");
    const entries = (tree?.args as { entries: Array<{ path: string; sha: string | null }> }).entries;
    expect(entries).toContainEqual({ path: "app.ts", mode: "100644", sha: null }); // deletion
    expect(entries.some((e) => e.path === "core.ts" && e.sha !== null)).toBe(true);
  });
});

describe("github.submit_code_changes — typed refusals (§29.7)", () => {
  it("EMPTY_DIFF when the workspace has no changes", async () => {
    await expect(submit()).rejects.toThrow(/EMPTY_DIFF/);
  });

  it("PLAN_REF_MISMATCH when the echoed plan_ref is not this task's plan", async () => {
    await ws.writeFile("app.ts", "export const x = 2;\n");
    await expect(
      submit({ plan_ref: { repo: REPO, doc_path: "docs/other.md", merge_commit_sha: baseSha } }),
    ).rejects.toThrow(/PLAN_REF_MISMATCH/);
  });

  it("PROTECTED_PATH when the diff touches .github/workflows/**", async () => {
    await ws.writeFile(".github/workflows/ci.yml", "on: push\n");
    await expect(submit()).rejects.toThrow(/PROTECTED_PATH.*\.github\/workflows\/ci\.yml/);
    expect(client.writes).toHaveLength(0); // refused before any GitHub write
  });

  it("declares publishing to the plan repo as internal egress (§7.8)", () => {
    const registry = new CodeTaskRegistry();
    registry.set(TASK_ID, { workspace: ws, planRef, repo: REPO, baseSha });
    const [tool] = makeGithubCodeTools({ getClient: () => client, registry, store });
    expect(tool!.egress?.({ plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: baseSha } })).toEqual({
      destination: `github:${REPO}`,
      audience: "tenant",
      external: false,
    });
  });

  it("egress_blocked when the task has read a restricted source (§7.8)", async () => {
    const ledger = new InMemorySourceLedger();
    ledger.record(TASK_ID, [{ source: "github:acme/secret-repo", sensitivity: "restricted" }]);
    const registry = new CodeTaskRegistry();
    registry.set(TASK_ID, { workspace: ws, planRef, repo: REPO, baseSha });
    const tools = makeGithubCodeTools({ getClient: () => client, registry, store });
    const guarded = new ToolGateway({
      registry: new ToolRegistry(tools),
      policy: { grants: [{ tool: "github.submit_code_changes" }] },
      secrets: { get: async () => null } as never,
      sourceLedger: ledger,
    });
    await ws.writeFile("app.ts", "export const x = 2;\n");
    const err = await guarded
      .run(
        "github.submit_code_changes",
        {
          title: "Add retry logic",
          summary: "Implements the retry plan.",
          plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: baseSha },
          verification: GREEN,
        },
        { taskId: TASK_ID, tenantId: "tenant-1" },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).code).toBe("egress_blocked");
    expect((err as ToolBlockedError).reason).toContain("github:acme/secret-repo");
    expect(client.writes).toHaveLength(0); // refused before any GitHub write
  });

  it("SECRET_IN_DIFF with a redacted pointer, never the secret", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    await ws.writeFile("config.ts", `export const token = "${secret}";\n`);
    const err = await submit().catch((e) => e as Error);
    expect(String(err)).toMatch(/SECRET_IN_DIFF/);
    expect(String(err)).toContain("config.ts");
    expect(String(err)).not.toContain(secret);
    expect(client.writes).toHaveLength(0);
  });

  it("DIFF_TOO_LARGE over the caps", async () => {
    const registry = new CodeTaskRegistry();
    registry.set(TASK_ID, { workspace: ws, planRef, repo: REPO, baseSha });
    const tools = makeGithubCodeTools({
      getClient: () => client,
      registry,
      store,
      caps: { maxChangedLines: 2 },
    });
    const tight = new ToolGateway({
      registry: new ToolRegistry(tools),
      policy: { grants: [{ tool: "github.submit_code_changes" }] },
      secrets: { get: async () => null } as never,
    });
    await ws.writeFile("big.ts", "a\nb\nc\nd\n");
    await expect(
      tight.run(
        "github.submit_code_changes",
        {
          title: "Big",
          summary: "Too big.",
          plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: baseSha },
          verification: GREEN,
        },
        { taskId: TASK_ID, tenantId: "tenant-1" },
      ),
    ).rejects.toThrow(/DIFF_TOO_LARGE/);
  });

  it("NO_WORKSPACE outside a BUILD stage", async () => {
    await expect(
      gateway.run(
        "github.submit_code_changes",
        {
          title: "T",
          summary: "S",
          plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: baseSha },
          verification: GREEN,
        },
        { taskId: "some-other-task", tenantId: "tenant-1" },
      ),
    ).rejects.toThrow(/NO_WORKSPACE/);
  });
});
