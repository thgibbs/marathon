import { InMemoryIdempotencyStore, revisionTaskKey, type CodeChange, type Task } from "@marathon/core";
import { DeliveryFanout, type NormalizedInvocation, type SurfaceAdapter } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { handleCodePrRevision, handleGithubMention, type GithubAppDeps } from "../src/handlers";

const REPO = "o/r";
const CODE_PR = 9;
const BRANCH = "marathon/impl-task-greet";
const TIP = "feedbeef1234";

const slackOrigin = { surfaceType: "slack" as const, ref: { channel: "C1", thread_ts: "1.1" } };
const codePrTarget = { surfaceType: "github" as const, ref: { repo: REPO, number: CODE_PR, kind: "pr" } };

function makeChange(overrides: Partial<CodeChange> = {}): CodeChange {
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
    ...overrides,
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
    deliveryTargets: [slackOrigin, codePrTarget],
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
  };
}

function invocation(overrides: Partial<NormalizedInvocation> = {}): NormalizedInvocation {
  return {
    surfaceType: "github",
    sourceRef: { repo: REPO, number: CODE_PR, kind: "pr", comment_id: 42 },
    userExternalId: "alice",
    agentName: null,
    text: "please also handle empty names",
    eventId: "ic-42",
    ...overrides,
  };
}

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(opts: { change?: CodeChange | null; branchGone?: boolean } = {}) {
  const progress: Array<{ ref: Record<string, unknown>; message: string }> = [];
  const direct: string[] = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => ({
    task: { ...makeImplTask(), id: "rev-task", ...input },
    deduped: false,
  }));
  const route = vi.fn(async () => {
    throw new Error("router.route must not run for a code-PR revision");
  });
  const adapter: SurfaceAdapter = {
    acknowledge: async () => {},
    postProgress: async (ref, message) => void progress.push({ ref, message }),
    deliverResult: async () => {},
  };
  const deps = {
    db: {
      findCodeChangeByPr: async () => opts.change ?? null,
      getTask: async () => makeImplTask(),
    },
    client: {
      getRepo: async () => ({ private: false }),
      getUserRepoPermission: async () => "write",
      getRef: async (_repo: string, ref: string) => {
        if (opts.branchGone) throw new Error("github 404: ref not found");
        expect(ref).toBe(`heads/${BRANCH}`);
        return { sha: TIP };
      },
    },
    delivery: {
      acknowledge: async () => {},
      postProgress: async (_ref: Record<string, unknown>, message: string) => void direct.push(message),
      deliverResult: async () => {},
    },
    orchestrator: { submit },
    router: { route },
    fanout: new DeliveryFanout({ slack: adapter, github: adapter }, new InMemoryIdempotencyStore()),
    tenantId: "tn1",
    agents: [{ name: "forge" }],
    agentIdByName: { forge: "a1" },
  } as never as GithubAppDeps;
  return { deps, submit, route, progress, direct };
}

describe("handleCodePrRevision (Track 10, §29.6)", () => {
  it("spawns a revision task pinned to the branch's CURRENT tip, updating the same branch/PR", async () => {
    const { deps, submit, progress } = makeDeps({ change: makeChange() });
    const handled = await handleCodePrRevision(deps, invocation());
    expect(handled).toBe(true);

    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.sourceTaskId).toBe("impl-task"); // chained to the implementation task
    expect(input.sourceRef).toMatchObject({
      kind: "code_revision",
      repo: REPO,
      prNumber: CODE_PR,
      branch: BRANCH,
      baseSha: TIP, // the branch tip, NOT the original merge commit
      planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: "cafe1234" },
    });
    expect(input.idempotencyKey).toBe(revisionTaskKey(REPO, CODE_PR, "ic-42"));
    // targets: inherited from the implementation task, plus the code PR itself
    expect(input.deliveryTargets).toEqual([slackOrigin, codePrTarget]);

    const brief = String(input.inputText);
    expect(brief).toContain(`branch ${BRANCH}`);
    expect(brief).toContain("please also handle empty names");
    expect(brief).toContain(`HEAD:refs/heads/${BRANCH}`); // same-branch push contract
    expect(brief).toContain("delivery.report_pr EXACTLY ONCE");

    expect(progress).toHaveLength(2); // fan-out heard about the queued revision
    expect(progress[0]!.message).toContain(`PR #${CODE_PR}`);
  });

  it("returns false for PRs Marathon did not create (the doc/draft flow handles them)", async () => {
    const { deps, submit } = makeDeps({ change: null });
    expect(await handleCodePrRevision(deps, invocation())).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("declines gracefully when the task branch no longer exists", async () => {
    const { deps, submit, direct } = makeDeps({ change: makeChange(), branchGone: true });
    expect(await handleCodePrRevision(deps, invocation())).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(direct[0]).toContain("no longer exists");
  });

  it("does not re-announce a deduped submit (webhook re-delivery)", async () => {
    const { deps, submit, progress } = makeDeps({ change: makeChange() });
    submit.mockResolvedValueOnce({ task: { ...makeImplTask(), id: "rev-task" }, deduped: true });
    await handleCodePrRevision(deps, invocation());
    expect(progress).toHaveLength(0);
  });
});

describe("handleGithubMention routing (Track 10)", () => {
  it("routes a mention on a Marathon code PR to the revision path, not the doc flow", async () => {
    const { deps, submit, route } = makeDeps({ change: makeChange() });
    await handleGithubMention(deps, invocation());
    expect(submit).toHaveBeenCalledTimes(1); // revision task spawned
    expect(route).not.toHaveBeenCalled(); // no doc task was routed
  });
});
