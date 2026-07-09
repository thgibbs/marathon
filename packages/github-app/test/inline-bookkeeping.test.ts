import type { AgentTurnContext } from "@marathon/agent";
import { InvalidTransitionError } from "@marathon/core";
import type { Database } from "@marathon/db";
import { describe, expect, it } from "vitest";
import { handleReviewTask, type GithubAppDeps } from "../src/handlers";

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
