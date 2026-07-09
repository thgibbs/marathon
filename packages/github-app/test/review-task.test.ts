import type { AgentTurnContext } from "@marathon/agent";
import type { Task } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { handleCodeReviewReady, handleReviewTask, runReviewCycle, type GithubAppDeps } from "../src/handlers";

/**
 * §A.3a review flow: a reviewer agent (task.agentId) reads the PR under review
 * — the doc content for a design review, the file patches for a code review —
 * and reports via review.report. The reviewer runs on ITS OWN runtime + model
 * role (design-review / code-review), gated on its own `on:`.
 */

const REPO = "o/r";

function reviewTask(kind: "design_review" | "code_review"): Task {
  return {
    id: "rev-task",
    tenantId: "tn1",
    agentId: "reviewer-id",
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "github",
    sourceRef: { kind, repo: REPO, number: 5 },
    deliveryTargets: null,
    status: "queued",
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

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(opts: { on?: string[]; models?: Record<string, string> } = {}) {
  const transitions: Array<[string, string]> = [];
  const turns: AgentTurnContext[] = [];
  const deps = {
    db: {
      findDocumentArtifactByPr: async () => ({ location: { path: "docs/plan.md", branch: "marathon/doc-b" } }),
      getLatestAgentVersion: async () => null,
      transitionTask: async (id: string, to: string) => void transitions.push([id, to]),
    },
    client: {
      readFileWithSha: async () => ({ content: "# The design doc under review", sha: "s" }),
      getPullRequestFiles: async () => [
        { filename: "src/limiter.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-old\n+new" },
      ],
    },
    tenantId: "tn1",
    // Route the reviewer id to its own runtime + policy (Phase 1 registry).
    agentRegistry: (id: string | undefined) =>
      id === "reviewer-id"
        ? {
            runtime: {
              nextTurn: async (ctx: AgentTurnContext) => {
                turns.push(ctx);
                return { text: "reviewed", done: true };
              },
            },
            on: opts.on ?? ["design-review", "code-review"],
            models: opts.models ?? { default: "openai:gpt-4o-mini" },
          }
        : undefined,
  } as never as GithubAppDeps;
  return { deps, transitions, turns };
}

describe("handleReviewTask (§A.3a)", () => {
  it("design review: puts the doc content in context, resolves the design-review role, completes", async () => {
    const { deps, transitions, turns } = makeDeps({ models: { default: "openai:gpt-4o-mini", "design-review": "openai:gpt-4o" } });
    await handleReviewTask(deps, reviewTask("design_review"));

    const req = turns[0]!.request;
    expect(req.instructions).toContain("review.report");
    expect(req.instructions).toContain(`PR #5`);
    // The doc rides in the untrusted context, not the trusted instructions.
    expect(req.input).toContain("The design doc under review");
    // The reviewer's own design-review model role resolved.
    expect(req.modelRef).toBe("openai:gpt-4o");
    expect(transitions).toEqual([["rev-task", "running"], ["rev-task", "completed"]]);
  });

  it("code review: puts the PR file patches in context and resolves the code-review role", async () => {
    const { deps, turns } = makeDeps({ models: { default: "openai:gpt-4o-mini", "code-review": "openai:gpt-4o" } });
    await handleReviewTask(deps, reviewTask("code_review"));

    const req = turns[0]!.request;
    expect(req.input).toContain("src/limiter.ts");
    expect(req.input).toContain("+new");
    expect(req.modelRef).toBe("openai:gpt-4o");
  });

  it("is a no-op when the reviewer doesn't subscribe to the review event", async () => {
    const { deps, transitions, turns } = makeDeps({ on: ["draft"] }); // not design-review
    await handleReviewTask(deps, reviewTask("design_review"));
    expect(turns).toHaveLength(0);
    expect(transitions).toEqual([["rev-task", "running"], ["rev-task", "completed"]]);
  });
});

describe("runReviewCycle — auto review + capped kickback loop (§A.3a, design-doc)", () => {
  // A stateful harness: each reviewer turn "reports" the next scripted verdict
  // (getReviewRound reflects it), and each owner turn counts one revision.
  function makeCycleDeps(verdicts: Array<"approved" | "changes_requested">) {
    let reviews = 0;
    let revisions = 0;
    const deps = {
      db: {
        findDocumentArtifactByPr: async () => ({ location: { path: "docs/plan.md", branch: "marathon/doc-b" } }),
        getLatestAgentVersion: async () => null,
        transitionTask: async () => {},
        getReviewRound: async () => (reviews === 0 ? null : { lastVerdict: verdicts[reviews - 1] ?? "approved", rounds: reviews }),
      },
      client: { readFileWithSha: async () => ({ content: "# doc", sha: "s" }), getPullRequestFiles: async () => [] },
      delivery: { loadContext: async () => [] },
      tenantId: "tn1",
      orchestrator: {
        submit: async (input: { agentId?: string; sourceRef?: Record<string, unknown> }) => ({
          task: { id: `t-${reviews}-${revisions}`, agentId: input.agentId, sourceRef: input.sourceRef, tenantId: "tn1" },
          deduped: false,
        }),
      },
      reviewerFor: () => "reviewer-id",
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? { runtime: { nextTurn: async () => { reviews++; return { text: "reviewed", done: true }; } }, on: ["design-review"], models: { default: "m" } }
          : { runtime: { nextTurn: async () => { revisions++; return { text: "revised", done: true }; } }, on: ["draft"], models: { default: "m" } },
    } as never as GithubAppDeps;
    return { deps, get reviews() { return reviews; }, get revisions() { return revisions; } };
  }

  it("approved on the first pass: one review, no revision", async () => {
    const h = makeCycleDeps(["approved"]);
    await runReviewCycle(h.deps, { repo: "o/r", prNumber: 5, kind: "design_review", ownerAgentId: "owner-id" });
    expect(h.reviews).toBe(1);
    expect(h.revisions).toBe(0);
  });

  it("changes_requested then approved: review → owner revises → re-review, then stops", async () => {
    const h = makeCycleDeps(["changes_requested", "approved"]);
    await runReviewCycle(h.deps, { repo: "o/r", prNumber: 5, kind: "design_review", ownerAgentId: "owner-id" });
    expect(h.reviews).toBe(2);
    expect(h.revisions).toBe(1);
  });

  it("persistent changes_requested is capped at MAX_AUTO_REVIEW_ROUNDS revisions (never ping-pongs forever)", async () => {
    const h = makeCycleDeps(["changes_requested", "changes_requested", "changes_requested", "changes_requested"]);
    await runReviewCycle(h.deps, { repo: "o/r", prNumber: 5, kind: "design_review", ownerAgentId: "owner-id" });
    // cap = 2 revisions: review1→revise→review2→revise→review3 (over cap) → stop.
    expect(h.reviews).toBe(3);
    expect(h.revisions).toBe(2);
  });

  it("no configured reviewer → the cycle is a no-op", async () => {
    const h = makeCycleDeps(["changes_requested"]);
    (h.deps as { reviewerFor?: unknown }).reviewerFor = () => undefined;
    await runReviewCycle(h.deps, { repo: "o/r", prNumber: 5, kind: "design_review", ownerAgentId: "owner-id" });
    expect(h.reviews).toBe(0);
    expect(h.revisions).toBe(0);
  });
});

describe("handleCodeReviewReady — code review fires when a code PR goes ready (§A.3a)", () => {
  it("ignores a PR that is not a Marathon code PR", async () => {
    const deps = { db: { findCodeChangeByPr: async () => null } } as never as GithubAppDeps;
    expect(await handleCodeReviewReady(deps, "o/r", 9)).toBe(false);
  });

  it("runs the code review (owned by the builder) for a Marathon code PR", async () => {
    let reviews = 0;
    const deps = {
      db: {
        findCodeChangeByPr: async () => ({ prNumber: 9, taskId: "code-task" }),
        getTask: async () => ({ id: "code-task", agentId: "owner-id" }),
        getReviewRound: async () => (reviews === 0 ? null : { lastVerdict: "approved", rounds: reviews }),
        getLatestAgentVersion: async () => null,
        transitionTask: async () => {},
      },
      client: { getPullRequestFiles: async () => [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@" }] },
      tenantId: "tn1",
      orchestrator: {
        submit: async (i: { agentId?: string; sourceRef?: Record<string, unknown> }) => ({
          task: { id: "rt", agentId: i.agentId, sourceRef: i.sourceRef, tenantId: "tn1" },
          deduped: false,
        }),
      },
      reviewerFor: (event: string) => (event === "code-review" ? "reviewer-id" : undefined),
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? { runtime: { nextTurn: async () => { reviews++; return { text: "r", done: true }; } }, on: ["code-review"], models: { default: "m" } }
          : undefined,
    } as never as GithubAppDeps;
    expect(await handleCodeReviewReady(deps, "o/r", 9)).toBe(true);
    expect(reviews).toBe(1);
  });
});
