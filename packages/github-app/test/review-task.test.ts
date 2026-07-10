import type { AgentTurnContext } from "@marathon/agent";
import type { Task } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { handleCodeReviewReady, handleDocReviewOpened, handleReviewTask, runCodeReviewJob, runDesignReviewJob, runReviewCycle, type GithubAppDeps } from "../src/handlers";

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

  it("FAILS CLOSED when the PR contents can't be read — never runs the reviewer on a fabricated empty diff", async () => {
    const turns: AgentTurnContext[] = [];
    const posted: string[] = [];
    // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
    const deps = {
      db: {
        getPullRequestFiles: async () => [],
        getLatestAgentVersion: async () => null,
        transitionTask: async () => {},
      },
      client: {
        getPullRequestFiles: async () => {
          throw new Error("github 500 fetching files");
        },
      },
      delivery: { postProgress: async (_ref: unknown, msg: string) => void posted.push(msg) },
      tenantId: "tn1",
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? {
              runtime: { nextTurn: async (ctx: AgentTurnContext) => { turns.push(ctx); return { text: "x", done: true }; } },
              on: ["code-review"],
              models: { default: "m" },
            }
          : undefined,
    } as never as GithubAppDeps;

    await handleReviewTask(deps, reviewTask("code_review"));
    // The reviewer NEVER ran (so it can't report a bogus `approved` on no diff)…
    expect(turns).toHaveLength(0);
    // …and an explicit infra-failure note was posted instead.
    expect(posted[0]).toContain("could not run");
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

  it("persistent changes_requested is capped at MAX_AUTO_REVIEW_ROUNDS rounds and ends on a revision (never ping-pongs forever)", async () => {
    const h = makeCycleDeps(["changes_requested", "changes_requested", "changes_requested", "changes_requested"]);
    await runReviewCycle(h.deps, { repo: "o/r", prNumber: 5, kind: "design_review", ownerAgentId: "owner-id" });
    // cap = 2 rounds, each a review + inline revision: review1→revise→review2→revise
    // → stop. The cycle ends on a revision (a human reviews the final revised doc).
    expect(h.reviews).toBe(2);
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

describe("runCodeReviewJob — the durable code-review trigger (§A.3a)", () => {
  it("is a no-op for a missing task id", async () => {
    const deps = {} as never as GithubAppDeps;
    expect(await runCodeReviewJob(deps, null)).toBe(false);
    expect(await runCodeReviewJob(deps, undefined)).toBe(false);
  });

  it("is a no-op when the task reported no PR (getCodeChangeByTask → null / unreported)", async () => {
    const noChange = { db: { getCodeChangeByTask: async () => null } } as never as GithubAppDeps;
    expect(await runCodeReviewJob(noChange, "code-task")).toBe(false);
    const unreported = { db: { getCodeChangeByTask: async () => ({ prNumber: null, repo: "o/r" }) } } as never as GithubAppDeps;
    expect(await runCodeReviewJob(unreported, "code-task")).toBe(false);
  });

  it("resolves task → code change → PR and runs the review", async () => {
    let reviews = 0;
    let reviewedPr: number | undefined;
    const deps = {
      db: {
        // The job carries the reporting task; resolve its code change for the PR.
        getCodeChangeByTask: async () => ({ prNumber: 42, repo: "o/r", taskId: "code-task" }),
        findCodeChangeByPr: async (_t: string, _r: string, n: number) => {
          reviewedPr = n;
          return { prNumber: n, taskId: "code-task" };
        },
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
    expect(await runCodeReviewJob(deps, "code-task")).toBe(true);
    expect(reviewedPr).toBe(42);
    expect(reviews).toBe(1);
  });
});

describe("handleDocReviewOpened — design review fires when a doc PR opens (§A.3a, surface-agnostic)", () => {
  it("ignores a PR with no produced doc artifact (code PR / human PR)", async () => {
    const deps = { db: { findDocumentArtifactByPr: async () => null } } as never as GithubAppDeps;
    expect(await handleDocReviewOpened(deps, "o/r", 9)).toBe(false);
  });

  it("ignores a non-produced doc artifact (e.g. a watched doc)", async () => {
    const deps = {
      db: { findDocumentArtifactByPr: async () => ({ role: "watched", owningAgentId: "a" }) },
    } as never as GithubAppDeps;
    expect(await handleDocReviewOpened(deps, "o/r", 9)).toBe(false);
  });

  it("runs the design review (owned by the drafter) for a Marathon-drafted doc PR — regardless of drafting surface", async () => {
    let reviews = 0;
    const submitted: Array<Record<string, unknown>> = [];
    const deps = {
      db: {
        // A Slack-drafted doc PR: role 'produced', owned by the drafting agent.
        findDocumentArtifactByPr: async () => ({ role: "produced", owningAgentId: "owner-id", location: { path: "docs/p.md", branch: "b" } }),
        getReviewRound: async () => (reviews === 0 ? null : { lastVerdict: "approved", rounds: reviews }),
        getLatestAgentVersion: async () => null,
        transitionTask: async () => {},
      },
      client: { getPullRequestFiles: async () => [], readFileWithSha: async () => ({ content: "# doc", sha: "s" }) },
      tenantId: "tn1",
      orchestrator: {
        submit: async (i: { agentId?: string; sourceRef?: Record<string, unknown> }) => {
          submitted.push({ agentId: i.agentId, sourceRef: i.sourceRef });
          return { task: { id: "rt", agentId: i.agentId, sourceRef: i.sourceRef, tenantId: "tn1" }, deduped: false };
        },
      },
      reviewerFor: (event: string) => (event === "design-review" ? "reviewer-id" : undefined),
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? { runtime: { nextTurn: async () => { reviews++; return { text: "r", done: true }; } }, on: ["design-review"], models: { default: "m" } }
          : undefined,
    } as never as GithubAppDeps;
    expect(await handleDocReviewOpened(deps, "o/r", 12)).toBe(true);
    expect(reviews).toBe(1);
    // The review task carried the design_review kind and the drafting agent as owner.
    expect(submitted[0]).toMatchObject({ agentId: "reviewer-id", sourceRef: { kind: "design_review", number: 12 } });
  });
});

describe("runDesignReviewJob — durable, race-free design-review trigger (§A.3a #19)", () => {
  it("no-ops on an empty task id", async () => {
    const deps = { db: {} } as never as GithubAppDeps;
    expect(await runDesignReviewJob(deps, null)).toBe(false);
  });

  it("no-ops when the task produced no doc artifact (a non-doc task)", async () => {
    const deps = { tenantId: "tn1", db: { findDocumentArtifactByTask: async () => null } } as never as GithubAppDeps;
    expect(await runDesignReviewJob(deps, "task-x")).toBe(false);
  });

  // The interleaving the reviewer flagged: the job is only ever enqueued AFTER
  // the recorder commits the produced artifact, so by the time the poller runs
  // this job, findDocumentArtifactByTask resolves it — the review runs. There is
  // no window in which the trigger observes a missing artifact and is dropped.
  it("resolves the task's produced doc PR and runs the review — the artifact is always present by job time", async () => {
    let reviews = 0;
    const byPrCalls: Array<[string, number]> = [];
    const deps = {
      tenantId: "tn1",
      db: {
        // Enqueued after the write ⇒ the job's task resolves to its produced PR.
        findDocumentArtifactByTask: async () => ({ role: "produced", location: { repo: "o/r", prNumber: 12, path: "docs/p.md", branch: "b" } }),
        findDocumentArtifactByPr: async (_t: string, repo: string, pr: number) => {
          byPrCalls.push([repo, pr]);
          return { role: "produced", owningAgentId: "owner-id", location: { path: "docs/p.md", branch: "b" } };
        },
        getReviewRound: async () => (reviews === 0 ? null : { lastVerdict: "approved", rounds: reviews }),
        getLatestAgentVersion: async () => null,
        transitionTask: async () => {},
      },
      client: { getPullRequestFiles: async () => [], readFileWithSha: async () => ({ content: "# doc", sha: "s" }) },
      orchestrator: {
        submit: async (i: { agentId?: string; sourceRef?: Record<string, unknown> }) => ({
          task: { id: "rt", agentId: i.agentId, sourceRef: i.sourceRef, tenantId: "tn1" },
          deduped: false,
        }),
      },
      reviewerFor: (event: string) => (event === "design-review" ? "reviewer-id" : undefined),
      agentRegistry: (id: string | undefined) =>
        id === "reviewer-id"
          ? { runtime: { nextTurn: async () => { reviews++; return { text: "r", done: true }; } }, on: ["design-review"], models: { default: "m" } }
          : undefined,
    } as never as GithubAppDeps;

    expect(await runDesignReviewJob(deps, "doc-task")).toBe(true);
    expect(reviews).toBe(1);
    // It routed by the PR resolved from the task (repo + number), not from the webhook.
    expect(byPrCalls[0]).toEqual(["o/r", 12]);
  });
});
