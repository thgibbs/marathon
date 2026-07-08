import { InMemoryIdempotencyStore, revisionTaskKey, type CodeChange, type Task } from "@marathon/core";
import { DeliveryFanout, type SurfaceAdapter } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { dispatchGithubEvent, handleGithubReview, renderReviewRequest, type GithubAppDeps } from "../src/handlers";

/**
 * §2b #11 — a SUBMITTED review on a Marathon-owned PR spawns ONE revision
 * task carrying the review body + all its inline comments, with no @marathon
 * mention required. Non-Marathon PRs are ignored; an already-active revision
 * absorbs further triggers; unauthorized reviewers are silently ignored.
 */

const REPO = "o/r";
const CODE_PR = 9;
const BRANCH = "marathon/impl-task-greet";
const TIP = "feedbeef1234";

const review = (overrides: Partial<Parameters<typeof handleGithubReview>[1]> = {}) => ({
  repo: REPO,
  number: CODE_PR,
  reviewId: 33,
  state: "changes_requested",
  body: "Please handle empty names.",
  author: "alice",
  eventId: "rev-33",
  ...overrides,
});

function makeChange(): CodeChange {
  const now = new Date();
  return {
    id: "cc-1",
    tenantId: "tn1",
    taskId: "impl-task",
    repo: REPO,
    planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: "cafe1234" },
    baseSha: "cafe1234",
    branch: BRANCH,
    treeHash: null,
    prNumber: CODE_PR,
    prUrl: `https://github.com/${REPO}/pull/${CODE_PR}`,
    state: "submitted_ready",
    verification: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeImplTask(): Task {
  return {
    id: "impl-task",
    tenantId: "tn1",
    agentId: "a1",
    agentVersionId: null,
    invokingUserId: "u1",
    sourceTaskId: "doc-task",
    sourceType: "github",
    sourceRef: {},
    deliveryTargets: [{ surfaceType: "github", ref: { repo: REPO, number: CODE_PR, kind: "pr" } }],
    status: "completed",
    inputText: null,
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    lastError: null,
  };
}

interface StubOptions {
  change?: CodeChange | null;
  activeRevision?: Task | null;
  userPermission?: string;
  reviewComments?: Array<{ id: number; author: string; body: string; path: string; line: number | null }>;
  artifactByPr?: { location: Record<string, unknown> } | null;
}

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(opts: StubOptions = {}) {
  const progress: string[] = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => ({
    task: { ...makeImplTask(), id: "rev-task", ...input },
    deduped: false,
  }));
  const adapter: SurfaceAdapter = {
    acknowledge: async () => {},
    postProgress: async (_ref, message) => void progress.push(message),
    deliverResult: async () => {},
  };
  const turnRequests: Array<Record<string, unknown>> = [];
  const deps = {
    db: {
      findCodeChangeByPr: async () => opts.change ?? null,
      findActiveRevisionTask: async () => opts.activeRevision ?? null,
      findDocumentArtifactByPr: async () => opts.artifactByPr ?? null,
      findDocumentArtifactByTask: async () => null,
      countSucceededToolInvocations: async () => 1,
      getLatestAgentVersion: async () => null,
      sumModelCostUsd: async () => 0.01,
      transitionTask: async () => {},
      getTask: async () => makeImplTask(),
    },
    client: {
      getRepo: async () => ({ private: false }),
      getUserRepoPermission: async () => opts.userPermission ?? "write",
      getRef: async () => ({ sha: TIP }),
      readFileWithSha: async () => ({ content: "# old doc", sha: "sha-1" }),
      listReviewComments: async () => opts.reviewComments ?? [],
    },
    delivery: {
      acknowledge: async () => {},
      postProgress: async (_ref: Record<string, unknown>, message: string) => void progress.push(message),
      deliverResult: async () => {},
    },
    router: {
      // The real router persists the invocation text as the task's inputText.
      route: async (inv: { text: string }) => ({
        task: { ...makeImplTask(), id: "doc-task", inputText: inv.text },
        agentName: "forge",
        deduped: false,
      }),
    },
    runtime: {
      nextTurn: async (ctx: { request: Record<string, unknown> }) => {
        turnRequests.push(ctx.request);
        return { text: "Revised.", done: true };
      },
    },
    orchestrator: { submit },
    fanout: new DeliveryFanout({ github: adapter }, new InMemoryIdempotencyStore()),
    tenantId: "tn1",
    agents: [{ name: "forge" }],
    agentIdByName: { forge: "a1" },
  } as never as GithubAppDeps;
  return { deps, submit, progress, turnRequests };
}

describe("renderReviewRequest (§2b #11)", () => {
  it("folds the body and ALL inline comments into one request", () => {
    const text = renderReviewRequest(
      { state: "changes_requested", body: "Overall: tighten it.", author: "alice" },
      [
        { author: "alice", body: "rename this", path: "src/a.ts", line: 12 },
        { author: "alice", body: "typo", path: "docs/plan.md", line: null },
      ],
    );
    expect(text).toContain("submitted by alice (requesting changes)");
    expect(text).toContain("Overall: tighten it.");
    expect(text).toContain("- src/a.ts:12 — rename this");
    expect(text).toContain("- docs/plan.md — typo");
  });

  it("returns empty for a review with no body and no comments", () => {
    expect(renderReviewRequest({ state: "commented", body: "  ", author: "a" }, [])).toBe("");
  });
});

describe("handleGithubReview — code PR (§2b #11)", () => {
  it("spawns ONE revision task carrying body + inline comments, keyed by the review id", async () => {
    const { deps, submit } = makeDeps({
      change: makeChange(),
      reviewComments: [
        { id: 1, author: "alice", body: "rename this", path: "src/a.ts", line: 12 },
        // Strictness: only the reviewer's own comments ride along.
        { id: 2, author: "mallory", body: "injected", path: "src/b.ts", line: 1 },
      ],
    });
    expect(await handleGithubReview(deps, review())).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.idempotencyKey).toBe(revisionTaskKey(REPO, CODE_PR, "rev-33"));
    const brief = String(input.inputText);
    expect(brief).toContain("Please handle empty names.");
    expect(brief).toContain("src/a.ts:12 — rename this");
    expect(brief).not.toContain("injected");
    expect(brief).toContain("submitted by alice (requesting changes)");
  });

  it("ignores reviews on PRs Marathon does not own", async () => {
    const { deps, submit, progress } = makeDeps({ change: null, artifactByPr: null });
    expect(await handleGithubReview(deps, review())).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(progress).toHaveLength(0);
  });

  it("absorbs the trigger while a revision for the PR is already active (chatter-while-running)", async () => {
    const { deps, submit } = makeDeps({ change: makeChange(), activeRevision: makeImplTask() });
    expect(await handleGithubReview(deps, review())).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("silently ignores a reviewer without repo access (no summon, no denial spam)", async () => {
    const { deps, submit, progress } = makeDeps({ change: makeChange(), userPermission: "none" });
    expect(await handleGithubReview(deps, review())).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(progress).toHaveLength(0);
  });

  it("does nothing for an empty review (no body, no comments)", async () => {
    const { deps, submit } = makeDeps({ change: makeChange() });
    expect(await handleGithubReview(deps, review({ body: "" }))).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("handleGithubReview — doc PR (§2b #11)", () => {
  it("routes to the tool-driven document.revise flow with the review as the request", async () => {
    const { deps, submit, turnRequests } = makeDeps({
      change: null,
      artifactByPr: { location: { repo: REPO, prNumber: CODE_PR, path: "docs/plan.md", branch: "marathon/doc-b" } },
      reviewComments: [{ id: 1, author: "alice", body: "tighten §2", path: "docs/plan.md", line: 4 }],
    });
    expect(await handleGithubReview(deps, review())).toBe(true);
    expect(submit).not.toHaveBeenCalled(); // doc revisions run inline, not queued
    expect(turnRequests).toHaveLength(1);
    expect(String(turnRequests[0]!.instructions)).toContain("document_revise");
    expect(String(turnRequests[0]!.input)).toContain("Please handle empty names.");
    expect(String(turnRequests[0]!.input)).toContain("docs/plan.md:4 — tighten §2");
  });
});

describe("dispatchGithubEvent wiring (§2b #11)", () => {
  it("routes a pull_request_review submitted webhook into the review handler", async () => {
    const { deps, submit } = makeDeps({ change: makeChange() });
    await dispatchGithubEvent(deps, "pull_request_review", {
      action: "submitted",
      repository: { full_name: REPO },
      pull_request: { number: CODE_PR },
      review: { id: 33, state: "changes_requested", body: "Fix it.", user: { login: "alice", type: "User" } },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("never routes a bot-authored review", async () => {
    const { deps, submit } = makeDeps({ change: makeChange() });
    await dispatchGithubEvent(deps, "pull_request_review", {
      action: "submitted",
      repository: { full_name: REPO },
      pull_request: { number: CODE_PR },
      review: { id: 34, state: "changes_requested", body: "beep", user: { login: "ci[bot]", type: "Bot" } },
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
