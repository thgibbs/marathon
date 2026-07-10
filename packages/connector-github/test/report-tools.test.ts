import { CodeTaskRegistry, InMemoryCodeChangeStore, type CodeWorkspace } from "@marathon/code-handoff";
import type { SecretStore } from "@marathon/config";
import { InMemoryIdempotencyStore, type DeliveryTarget } from "@marathon/core";
import { DeliveryFanout, type StructuredResult, type SurfaceAdapter } from "@marathon/surface";
import type { ToolContext } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { makeDeliveryReportTool, parsePrUrl } from "../src/report-tools";

const REPO = "acme/service";
const TASK = "task-1";
const PLAN = { repo: REPO, docPath: "docs/plan.md", approvedSha: "abc123" };
const secrets: SecretStore = { get: async () => "tok" };
const ctx: ToolContext = { taskId: TASK, tenantId: "tenant-1", secrets };

class RecordingAdapter implements SurfaceAdapter {
  public readonly results: Array<{ ref: Record<string, unknown>; result: StructuredResult }> = [];
  async acknowledge(): Promise<void> {}
  async postProgress(): Promise<void> {}
  async deliverResult(ref: Record<string, unknown>, result: StructuredResult): Promise<void> {
    this.results.push({ ref, result });
  }
}

function setup(
  opts: {
    targets?: DeliveryTarget[];
    bind?: boolean;
    getCostUsd?: (taskId: string) => Promise<number | null>;
    /** Pin the binding to ONE expected PR/branch (§29.1a same-PR enforcement). */
    expected?: { prNumber?: number; branch?: string };
  } = {},
) {
  const client = new FixturesGithubClient({});
  const store = new InMemoryCodeChangeStore();
  const registry = new CodeTaskRegistry();
  if (opts.bind !== false) {
    // The tool never touches the workspace — a stub satisfies the binding.
    registry.set(TASK, {
      workspace: {} as never as CodeWorkspace,
      planRef: PLAN,
      repo: REPO,
      baseSha: PLAN.approvedSha,
      expectedPrNumber: opts.expected?.prNumber,
      expectedBranch: opts.expected?.branch,
    });
  }
  const slack = new RecordingAdapter();
  const github = new RecordingAdapter();
  const fanout = new DeliveryFanout({ slack, github }, new InMemoryIdempotencyStore());
  const targets: DeliveryTarget[] = opts.targets ?? [
    { surfaceType: "slack", ref: { channel: "C1", thread_ts: "t1" } },
    { surfaceType: "github", ref: { repo: REPO, number: 7, kind: "pr" } },
  ];
  const reported: Array<{ taskId: string; prUrl: string; ready: boolean }> = [];
  const tool = makeDeliveryReportTool({
    getClient: () => client,
    registry,
    store,
    fanout,
    getDeliveryTargets: async () => targets,
    getCostUsd: opts.getCostUsd,
    onReported: (info) => void reported.push({ taskId: info.taskId, prUrl: info.prUrl, ready: info.ready }),
  });
  return { client, store, registry, slack, github, tool, reported };
}

describe("parsePrUrl", () => {
  it("parses github.com and GHES/fixture PR urls", () => {
    expect(parsePrUrl("https://github.com/acme/service/pull/12")).toEqual({ repo: "acme/service", number: 12 });
    expect(parsePrUrl("https://example.test/acme/service/pull/3")).toEqual({ repo: "acme/service", number: 3 });
    expect(parsePrUrl("https://github.com/acme/service/pull/12/files")).toEqual({ repo: "acme/service", number: 12 });
  });
  it("rejects non-PR urls", () => {
    expect(parsePrUrl("https://github.com/acme/service")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/service/issues/12")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
  });
});

describe("delivery.report_pr (Track 7)", () => {
  const green = [{ command: "pnpm test", exit_code: 0, summary: "ok" }];

  it("validates its input", () => {
    const { tool } = setup();
    expect(tool.validate?.({})).toMatch(/pr_url/);
    expect(tool.validate?.({ pr_url: "nope", summary: "s" })).toMatch(/pr_url must look like/);
    expect(tool.validate?.({ pr_url: "https://github.com/a/b/pull/1" })).toMatch(/summary/);
    expect(tool.validate?.({ pr_url: "https://github.com/a/b/pull/1", summary: "s", verification: "x" })).toMatch(/verification/);
    expect(
      tool.validate?.({ pr_url: "https://github.com/a/b/pull/1", summary: "s", verification: [{ command: "t" }] }),
    ).toMatch(/exit_code/);
    expect(tool.validate?.({ pr_url: "https://github.com/a/b/pull/1", summary: "s", verification: green })).toBeNull();
  });

  it("declares tenant-internal egress to the PR's repo", () => {
    const { tool } = setup();
    expect(tool.egress?.({ pr_url: `https://github.com/${REPO}/pull/4` })).toEqual({
      destination: `github:${REPO}`,
      audience: "tenant",
      external: false,
    });
    expect(tool.egress?.({ pr_url: 42 })).toBeNull();
  });

  it("records the PR on the CodeChange and fans the link out to every target", async () => {
    const { client, store, slack, github, tool, reported } = setup();
    const pr = await client.createPullRequest(REPO, "Greet by name", "marathon/task-1-greet", "main", "body");

    const res = await tool.execute({ pr_url: pr.url, summary: "Implemented the plan.", verification: green }, ctx);

    const change = await store.getCodeChangeByTask(TASK);
    expect(change).toMatchObject({
      repo: REPO,
      prNumber: pr.number,
      prUrl: pr.url,
      branch: "marathon/task-1-greet", // from GitHub, not the model
      state: "submitted_ready",
      baseSha: PLAN.approvedSha,
    });
    expect(change?.verification).toEqual([{ command: "pnpm test", exitCode: 0, summary: "ok" }]);
    expect(slack.results).toHaveLength(1);
    expect(github.results).toHaveLength(1);
    expect(slack.results[0]?.result.actionsTaken).toEqual([`Opened PR: ${pr.url}`]);
    expect(reported).toEqual([{ taskId: TASK, prUrl: pr.url, ready: true }]);
    expect(res.details).toMatchObject({ pr_number: pr.number, state: "submitted_ready", verified: true, delivered: 2 });
  });

  it("carries the silent cost footer on the fanned-out result (Track 16, §13.3)", async () => {
    const { client, slack, github, tool } = setup({ getCostUsd: async () => 0.1234 });
    const pr = await client.createPullRequest(REPO, "T", "b-cost", "main");
    await tool.execute({ pr_url: pr.url, summary: "s", verification: green }, ctx);
    expect(slack.results[0]?.result.costUsd).toBe(0.1234);
    expect(github.results[0]?.result.costUsd).toBe(0.1234);
  });

  it("is idempotent per target: a retried report cannot double-post", async () => {
    const { client, slack, github, tool } = setup();
    const pr = await client.createPullRequest(REPO, "T", "b1", "main");
    await tool.execute({ pr_url: pr.url, summary: "s", verification: green }, ctx);
    const again = await tool.execute({ pr_url: pr.url, summary: "s", verification: green }, ctx);
    expect(slack.results).toHaveLength(1);
    expect(github.results).toHaveLength(1);
    expect(again.details).toMatchObject({ delivered: 0 });
  });

  it("refuses to report a DIFFERENT PR once one is recorded (no silent overwrite)", async () => {
    const { client, store, tool } = setup();
    const first = await client.createPullRequest(REPO, "T1", "b1", "main");
    const second = await client.createPullRequest(REPO, "T2", "b2", "main");
    await tool.execute({ pr_url: first.url, summary: "s", verification: green }, ctx);
    await expect(tool.execute({ pr_url: second.url, summary: "s", verification: green }, ctx)).rejects.toThrow(
      new RegExp(`already reported PR #${first.number}`),
    );
    // The record still points at the first PR — nothing diverged.
    expect((await store.getCodeChangeByTask(TASK))?.prNumber).toBe(first.number);
  });

  it("the draft state tracks verification, ENFORCED on GitHub (§29.3 single authority)", async () => {
    // Green verification on a (still-)draft combined PR → marked ready.
    const { client, store, tool } = setup();
    const draftPr = await client.createPullRequest(REPO, "T", "b-draft", "main", "", { draft: true });
    await tool.execute({ pr_url: draftPr.url, summary: "s", verification: green }, ctx);
    expect((await store.getCodeChangeByTask(TASK))?.state).toBe("submitted_ready");
    expect(client.writes).toContainEqual({
      op: "setPullRequestDraft",
      args: { repo: REPO, prNumber: draftPr.number, draft: false },
    });
    expect((await client.getPullRequest(REPO, draftPr.number))?.draft).toBe(false);

    // Red verification on a PR prematurely marked ready (`gh pr ready` before
    // green) → converted BACK to draft; Marathon's record and GitHub agree.
    const { client: c2, store: s2, tool: t2 } = setup();
    const readyPr = await c2.createPullRequest(REPO, "T", "b-ready", "main");
    const red = [{ command: "pnpm test", exit_code: 1, summary: "3 failed" }];
    const resRed = await t2.execute({ pr_url: readyPr.url, summary: "s", verification: red }, ctx);
    expect((await s2.getCodeChangeByTask(TASK))?.state).toBe("submitted_draft");
    expect(c2.writes).toContainEqual({
      op: "setPullRequestDraft",
      args: { repo: REPO, prNumber: readyPr.number, draft: true },
    });
    expect((await c2.getPullRequest(REPO, readyPr.number))?.draft).toBe(true);
    expect(resRed.details).toMatchObject({ verified: false, draft_enforced: true });
    expect(resRed.content).toContain("converted back to draft");

    // Missing verification behaves like red: draft enforced + flagged.
    const { client: c3, store: s3, slack: sl3, tool: t3 } = setup();
    const pr3 = await c3.createPullRequest(REPO, "T", "b3", "main");
    const res = await t3.execute({ pr_url: pr3.url, summary: "s" }, ctx);
    expect((await s3.getCodeChangeByTask(TASK))?.state).toBe("submitted_draft");
    expect((await c3.getPullRequest(REPO, pr3.number))?.draft).toBe(true);
    expect(sl3.results[0]?.result.openQuestions).toEqual(["No verification results were reported."]);
    expect(res.details).toMatchObject({ verified: false });

    // Already-correct states are left alone (no redundant GitHub write).
    const { client: c4, tool: t4 } = setup();
    const draft4 = await c4.createPullRequest(REPO, "T", "b4", "main", "", { draft: true });
    await t4.execute({ pr_url: draft4.url, summary: "s" }, ctx);
    expect(c4.writes.filter((w) => w.op === "setPullRequestDraft")).toHaveLength(0);
  });

  it("onReported carries ready=true for a green report — including a green report on an ALREADY-ready PR (the in-place doc→code case, no draft flip, no webhook) — the durable code-review trigger (§A.3a)", async () => {
    // Already-ready PR + green verification: report_pr does NOT flip draft (so
    // GitHub emits no ready_for_review webhook), yet the delivery IS ready — the
    // onReported hook must report ready=true so the durable code-review job fires.
    const { client, tool, reported } = setup();
    const readyPr = await client.createPullRequest(REPO, "T", "b-inplace", "main"); // opens ready (not draft)
    await tool.execute({ pr_url: readyPr.url, summary: "s", verification: green }, ctx);
    expect(client.writes.filter((w) => w.op === "setPullRequestDraft")).toHaveLength(0); // no flip → no webhook
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ prUrl: readyPr.url, ready: true });

    // A red/missing report is NOT ready → the live wiring enqueues no review.
    const { client: c2, tool: t2, reported: r2 } = setup();
    const red = await c2.createPullRequest(REPO, "T", "b-red", "main");
    await t2.execute({ pr_url: red.url, summary: "s", verification: [{ command: "pnpm test", exit_code: 1, summary: "fail" }] }, ctx);
    expect(r2[0]).toMatchObject({ ready: false });
  });

  it("rejects any PR but the task's own when the binding pins one (§29.1a same-PR invariant)", async () => {
    // The implementation task is bound to its doc PR; a fresh same-repo PR the
    // agent opened anyway is refused with an actionable, typed error.
    const { client, store, tool } = setup({ expected: { prNumber: 1, branch: "marathon/doc-t1-plan" } });
    const docPr = await client.createPullRequest(REPO, "Plan", "marathon/doc-t1-plan", "main", "", { draft: true });
    expect(docPr.number).toBe(1);
    const rogue = await client.createPullRequest(REPO, "Rogue", "marathon/other-branch", "main");
    await expect(tool.execute({ pr_url: rogue.url, summary: "s", verification: green }, ctx)).rejects.toThrow(
      /PR_MISMATCH.*must deliver on PR #1/,
    );
    // Nothing was recorded or delivered for the rogue PR.
    expect(await store.getCodeChangeByTask(TASK)).toBeNull();

    // The bound PR itself is accepted.
    const ok = await tool.execute({ pr_url: docPr.url, summary: "s", verification: green }, ctx);
    expect(ok.details).toMatchObject({ pr_number: 1, state: "submitted_ready" });
  });

  it("rejects a bound-number PR whose head branch is not the task's branch", async () => {
    // Same number, wrong head: the binding validates the branch too.
    const { client, tool } = setup({ expected: { prNumber: 1, branch: "marathon/doc-t1-plan" } });
    await client.createPullRequest(REPO, "Other", "some/other-head", "main");
    await expect(
      tool.execute({ pr_url: `https://example.test/${REPO}/pull/1`, summary: "s", verification: green }, ctx),
    ).rejects.toThrow(/PR_MISMATCH.*head branch is some\/other-head/);
  });

  it("refuses outside a BUILD stage and outside the task's repo", async () => {
    const { tool } = setup({ bind: false });
    await expect(tool.execute({ pr_url: `https://github.com/${REPO}/pull/1`, summary: "s" }, ctx)).rejects.toThrow(
      /NO_WORKSPACE/,
    );

    const { client, tool: bound } = setup();
    await client.createPullRequest("other/repo", "T", "b", "main");
    await expect(bound.execute({ pr_url: "https://github.com/other/repo/pull/1", summary: "s" }, ctx)).rejects.toThrow(
      /PLAN_REF_MISMATCH/,
    );
  });

  it("refuses a PR that does not exist in the repo", async () => {
    const { tool } = setup();
    await expect(tool.execute({ pr_url: `https://github.com/${REPO}/pull/999`, summary: "s" }, ctx)).rejects.toThrow(
      /has no PR #999/,
    );
  });

  it("still records when no fanout is wired", async () => {
    const client = new FixturesGithubClient({});
    const store = new InMemoryCodeChangeStore();
    const registry = new CodeTaskRegistry();
    registry.set(TASK, { workspace: {} as never as CodeWorkspace, planRef: PLAN, repo: REPO, baseSha: PLAN.approvedSha });
    const tool = makeDeliveryReportTool({ getClient: () => client, registry, store });
    const pr = await client.createPullRequest(REPO, "T", "b", "main");
    const res = await tool.execute({ pr_url: pr.url, summary: "s", verification: green }, ctx);
    expect(res.details).toMatchObject({ delivered: 0 });
    expect((await store.getCodeChangeByTask(TASK))?.prNumber).toBe(pr.number);
  });
});
