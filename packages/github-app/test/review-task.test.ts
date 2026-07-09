import type { AgentTurnContext } from "@marathon/agent";
import type { Task } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { handleReviewTask, type GithubAppDeps } from "../src/handlers";

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
