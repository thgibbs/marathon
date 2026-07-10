import type { AgentTurnContext } from "@marathon/agent";
import { InvalidTransitionError, type Task } from "@marathon/core";
import type { Database } from "@marathon/db";
import type { NormalizedInvocation } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { handleGithubMention, handleReviewTask, type GithubAppDeps } from "../src/handlers";

/**
 * Tests for Fix 2 (defense-in-depth): the post-turn bookkeeping transitions
 * (queued→running→completed) in inline-driven handlers must not throw when a
 * racing consumer already completed the task. A throw at that point would cause
 * the queue job to retry the whole turn, duplicating PR comments.
 *
 * Also covers: a genuine DB error (not an invalid-transition error) must still
 * propagate — safeCompleteTask must not swallow real failures.
 */

const REPO = "o/r";

function reviewTask() {
  return {
    id: "rev-task",
    tenantId: "tn1",
    agentId: "reviewer-id",
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "github" as const,
    sourceRef: { kind: "design_review", repo: REPO, number: 5 },
    deliveryTargets: null,
    status: "queued" as const,
    inputText: "",
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

/** Build deps whose transitionTask throws the given error. */
function makeDepsWithTransitionError(err: Error) {
  const turns: AgentTurnContext[] = [];
  const deps = {
    db: {
      findDocumentArtifactByPr: async () => ({ location: { path: "docs/plan.md", branch: "b" } }),
      getLatestAgentVersion: async () => null,
      // Throws on every transitionTask call — simulates either a racing
      // completion or a genuine DB error, depending on the error type.
      transitionTask: async () => { throw err; },
    } as never as Database,
    client: {
      readFileWithSha: async () => ({ content: "# The design doc", sha: "s" }),
    },
    tenantId: "tn1",
    agentRegistry: (id: string | undefined) =>
      id === "reviewer-id"
        ? {
            runtime: {
              nextTurn: async (ctx: AgentTurnContext) => {
                turns.push(ctx);
                return { text: "reviewed", done: true };
              },
            },
            on: ["design-review"],
            models: { default: "m" },
          }
        : undefined,
  } as never as GithubAppDeps;
  return { deps, turns };
}

describe("safeCompleteTask (Fix 2): race-safe post-turn bookkeeping in handleReviewTask", () => {
  it("does NOT throw when the task was already completed by a racing consumer (InvalidTransitionError)", async () => {
    // Simulates the observed production symptom: the inline handler tries to
    // mark completed→running, but the task is already 'completed'. This must
    // NOT propagate — the PR comment already landed, and a throw would retry
    // the whole turn and duplicate the comment.
    const raceErr = new InvalidTransitionError("completed", "running");
    const { deps } = makeDepsWithTransitionError(raceErr);

    // Must resolve without throwing, even though transitionTask throws.
    await expect(handleReviewTask(deps, reviewTask())).resolves.toBeUndefined();
  });

  it("DOES propagate a genuine DB error (not an invalid-transition error)", async () => {
    // Only InvalidTransitionError is tolerated. A real DB outage or unexpected
    // error must still bubble up so the job retries / dead-letters correctly.
    const dbErr = new Error("connection refused");
    const { deps } = makeDepsWithTransitionError(dbErr);

    await expect(handleReviewTask(deps, reviewTask())).rejects.toThrow("connection refused");
  });

  it("regression: handleReviewTask completes normally when the turn succeeds and there is no race", async () => {
    // The happy path must still complete correctly after the fix — the
    // safeCompleteTask wrapper must not break the normal flow.
    const transitions: Array<[string, string]> = [];
    const turns: AgentTurnContext[] = [];
    const deps = {
      db: {
        findDocumentArtifactByPr: async () => ({ location: { path: "docs/plan.md", branch: "b" } }),
        getLatestAgentVersion: async () => null,
        transitionTask: async (id: string, to: string) => {
          transitions.push([id, to]);
          return { id, status: to };
        },
      },
      client: {
        readFileWithSha: async () => ({ content: "# doc", sha: "s" }),
      },
      tenantId: "tn1",
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? {
              runtime: {
                nextTurn: async (ctx: AgentTurnContext) => {
                  turns.push(ctx);
                  return { text: "looks good", done: true };
                },
              },
              on: ["design-review"],
              models: { default: "m" },
            }
          : undefined,
    } as never as GithubAppDeps;

    await handleReviewTask(deps, reviewTask());

    // The reviewer ran exactly once and the task completed.
    expect(turns).toHaveLength(1);
    expect(transitions).toEqual([["rev-task", "running"], ["rev-task", "completed"]]);
  });
});

// ---------------------------------------------------------------------------
// P2 — a redelivered surface event (router dedup) must not re-run the mention
// flow, and the inline job's completeInline handle is acked on success paths
// only (never on the dedup early-return).
// ---------------------------------------------------------------------------

function mentionTask(): Task {
  return {
    id: "doc-task",
    tenantId: "tn1",
    agentId: "a1",
    agentVersionId: null,
    invokingUserId: "u1",
    sourceTaskId: null,
    sourceType: "github",
    sourceRef: { repo: REPO, number: 20, kind: "issue" },
    deliveryTargets: null,
    status: "queued",
    inputText: "draft a plan",
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

function mentionInvocation(eventId: string): NormalizedInvocation {
  return {
    surfaceType: "github",
    sourceRef: { repo: REPO, number: 20, kind: "issue" },
    userExternalId: "alice",
    agentName: "quill",
    text: "draft a plan",
    eventId,
  };
}

/**
 * doc-flow.test.ts-style deps, plus a STATEFUL router that dedupes on the
 * surface eventId like the real InvocationRouter: the first route of an event
 * returns a fresh task with the completeInline ack handle; a repeat of the
 * same eventId returns { deduped: true } with NO handle (the original
 * submitter owns the ack).
 */
function makeMentionDeps(opts: { artifactByTask?: { location: Record<string, unknown> } | null } = {}) {
  const transitions: Array<[string, string]> = [];
  const delivered: Array<{ summary: string }> = [];
  const turnContexts: AgentTurnContext[] = [];
  const completeInline = vi.fn(async () => {});
  const seenEvents = new Set<string>();
  let routeCalls = 0;
  const deps = {
    db: {
      findCodeChangeByPr: async () => null,
      findDocumentArtifactByPr: async () => null,
      findDocumentArtifactByTask: async () => opts.artifactByTask ?? null,
      countSucceededToolInvocations: async () => 0,
      getLatestAgentVersion: async () => null,
      sumModelCostUsd: async () => 0,
      transitionTask: async (id: string, to: string) => void transitions.push([id, to]),
    },
    client: {
      getRepo: async () => ({ private: false }),
      getUserRepoPermission: async () => "write",
      readFileWithSha: async () => ({ content: "# doc", sha: "s" }),
    },
    delivery: {
      acknowledge: async () => {},
      postProgress: async () => {},
      deliverResult: async (_ref: Record<string, unknown>, result: { summary: string }) =>
        void delivered.push({ summary: result.summary }),
    },
    router: {
      route: async (inv: NormalizedInvocation) => {
        routeCalls++;
        const key = inv.eventId ?? `no-event-${routeCalls}`;
        if (seenEvents.has(key)) {
          // Redelivery: the real router finds the existing job row and
          // returns the ORIGINAL task, deduped, with no ack handle.
          return { task: mentionTask(), agentName: "quill", deduped: true };
        }
        seenEvents.add(key);
        return { task: mentionTask(), agentName: "quill", deduped: false, completeInline };
      },
    },
    runtime: {
      nextTurn: async (ctx: AgentTurnContext) => {
        turnContexts.push(ctx);
        return { text: "Drafted.", done: true };
      },
    },
    tenantId: "tn1",
    agents: [{ name: "quill" }],
    agentIdByName: { quill: "a1" },
  } as never as GithubAppDeps;
  return { deps, transitions, delivered, turnContexts, completeInline, routeCalls: () => routeCalls };
}

describe("handleGithubMention dedup early-return (P2): a redelivered event never re-runs the turn", () => {
  it("routes the same eventId twice → exactly ONE runtime turn and ONE delivered result", async () => {
    const h = makeMentionDeps({
      artifactByTask: { location: { repo: REPO, prNumber: 7, path: "docs/plan.md", branch: "marathon/doc-x" } },
    });

    await handleGithubMention(h.deps, mentionInvocation("ev-dup"));
    await handleGithubMention(h.deps, mentionInvocation("ev-dup"));

    // Both deliveries reached the router…
    expect(h.routeCalls()).toBe(2);
    // …but the turn ran once and the result was posted once — the duplicate
    // returned before the inline flow (no duplicate PR comment/doc write).
    expect(h.turnContexts).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  it("acks completeInline on the successful run, and does NOT ack on the deduped redelivery", async () => {
    const h = makeMentionDeps({
      artifactByTask: { location: { repo: REPO, prNumber: 7, path: "docs/plan.md", branch: "marathon/doc-x" } },
    });

    await handleGithubMention(h.deps, mentionInvocation("ev-ack"));
    // The draft-success path parks the TASK at waiting_for_approval but the
    // inline EXECUTION is finished — the job must be acked exactly here.
    expect(h.completeInline).toHaveBeenCalledTimes(1);
    expect(h.transitions).toEqual([["doc-task", "running"], ["doc-task", "waiting_for_approval"]]);

    await handleGithubMention(h.deps, mentionInvocation("ev-ack"));
    // The dedup early-return neither re-acks nor re-transitions anything.
    expect(h.completeInline).toHaveBeenCalledTimes(1);
    expect(h.transitions).toHaveLength(2);
  });

  it("acks completeInline on the no-artifact completion path too (every terminal path acks)", async () => {
    const h = makeMentionDeps({ artifactByTask: null });

    await handleGithubMention(h.deps, mentionInvocation("ev-noart"));

    expect(h.delivered[0]!.summary).toContain("nothing was committed");
    expect(h.transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);
    expect(h.completeInline).toHaveBeenCalledTimes(1);
  });
});
