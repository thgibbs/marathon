import type { AgentTurnContext } from "@marathon/agent";
import type { Task } from "@marathon/core";
import type { NormalizedInvocation } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { handleGithubMention, type GithubAppDeps } from "../src/handlers";

/**
 * §2b #16 — doc writes are tool calls, not committed chat text. These tests
 * pin the contract: the handler NEVER commits the model's turn text; the doc
 * exists only if the agent's own `document.*` tool call left evidence (the
 * artifact for drafts, an ok ToolInvocation for revisions); a turn with no
 * evidence reports a visible no-op; the turn's text is only the reply.
 */

const REPO = "o/r";

function makeTask(): Task {
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
    inputText: "draft a plan for rate limiting",
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

function invocation(overrides: Partial<NormalizedInvocation> = {}): NormalizedInvocation {
  return {
    surfaceType: "github",
    sourceRef: { repo: REPO, number: 20, kind: "issue" },
    userExternalId: "alice",
    agentName: "quill",
    text: "draft a plan for rate limiting",
    eventId: "ev-1",
    ...overrides,
  };
}

interface StubOptions {
  /** The turn the fake runtime returns (its text is the in-thread reply). */
  turnText?: string;
  /** What findDocumentArtifactByTask returns (draft-path evidence). */
  artifactByTask?: { location: Record<string, unknown> } | null;
  /** What findDocumentArtifactByPr returns (routes to the revise path). */
  artifactByPr?: { location: Record<string, unknown> } | null;
  /** What countSucceededToolInvocations returns (revise-path evidence). */
  okInvocations?: number;
}

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(opts: StubOptions = {}) {
  const transitions: Array<[string, string]> = [];
  const delivered: Array<{ ref: Record<string, unknown>; summary: string }> = [];
  const turnContexts: AgentTurnContext[] = [];
  const gatewayRun = vi.fn(); // the handler must NEVER reach for a gateway
  const countCalls: string[][] = [];
  const deps = {
    db: {
      findCodeChangeByPr: async () => null,
      findDocumentArtifactByPr: async () => opts.artifactByPr ?? null,
      findDocumentArtifactByTask: async () => opts.artifactByTask ?? null,
      countSucceededToolInvocations: async (_taskId: string, toolIds: string[]) => {
        countCalls.push(toolIds);
        return opts.okInvocations ?? 0;
      },
      getLatestAgentVersion: async () => null,
      sumModelCostUsd: async () => 0.01,
      transitionTask: async (id: string, to: string) => void transitions.push([id, to]),
    },
    client: {
      getRepo: async () => ({ private: false }),
      getUserRepoPermission: async () => "write",
      readFileWithSha: async () => ({ content: "# old doc", sha: "sha-1" }),
    },
    delivery: {
      acknowledge: async () => {},
      postProgress: async () => {},
      deliverResult: async (ref: Record<string, unknown>, result: { summary: string }) =>
        void delivered.push({ ref, summary: result.summary }),
    },
    router: { route: async () => ({ task: makeTask(), agentName: "quill", deduped: false }) },
    runtime: {
      nextTurn: async (ctx: AgentTurnContext) => {
        turnContexts.push(ctx);
        return { text: opts.turnText ?? "Here is my reply.", done: true };
      },
    },
    gateway: { run: gatewayRun }, // present only to prove it is never used
    tenantId: "tn1",
    agents: [{ name: "quill" }],
    agentIdByName: { quill: "a1" },
  } as never as GithubAppDeps;
  return { deps, transitions, delivered, turnContexts, gatewayRun, countCalls };
}

describe("draft flow (§2b #16 — tool-driven)", () => {
  it("prompts the doc contract and delivers the PR when the agent's document.create left an artifact", async () => {
    const { deps, transitions, delivered, turnContexts, gatewayRun } = makeDeps({
      turnText: "Drafted a token-bucket design.",
      artifactByTask: { location: { repo: REPO, prNumber: 7, path: "docs/plan.md", branch: "marathon/doc-x" } },
    });
    await handleGithubMention(deps, invocation());

    // The contract rides in the TRUSTED instructions: tool, repo, suggested path.
    const req = turnContexts[0]!.request;
    expect(req.instructions).toContain("document_create");
    expect(req.instructions).toContain(`repo "${REPO}"`);
    expect(req.instructions).toContain("docs/draft-a-plan-for-rate-limiting.md");
    expect(req.instructions).toContain("never include the document body");
    // Governed tool calls need the task identity on the request.
    expect(req.tenantId).toBe("tn1");
    expect(req.agentId).toBe("a1");

    // The reply is the turn text + the deterministic outcome, never the doc.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.summary).toContain("Drafted a token-bucket design.");
    expect(delivered[0]!.summary).toContain("Drafted design doc: PR #7");

    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "waiting_for_approval"]]);
    expect(gatewayRun).not.toHaveBeenCalled(); // the handler commits NOTHING itself
  });

  it("reports a visible no-op (and completes the task) when no artifact was produced", async () => {
    const { deps, transitions, delivered } = makeDeps({
      turnText: "This looks like a question — answering instead.",
      artifactByTask: null,
    });
    await handleGithubMention(deps, invocation());

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.summary).toContain("This looks like a question");
    expect(delivered[0]!.summary).toContain("No design document was produced by this run — nothing was committed");
    // No doc PR -> nothing to wait on: the task completes instead of parking.
    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);
  });

  it("never commits the turn text even when it looks like a document", async () => {
    const { deps, delivered, gatewayRun } = makeDeps({
      turnText: "I'll draft the plan now.\n```markdown\n# Plan\n```\nNow, I'll continue…",
      artifactByTask: null,
    });
    await handleGithubMention(deps, invocation());
    // The old flow committed exactly this text; now it is only the reply.
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(delivered[0]!.summary).toContain("nothing was committed");
  });
});

describe("revise flow (§2b #16 — tool-driven)", () => {
  const prInvocation = () =>
    invocation({ sourceRef: { repo: REPO, number: 5, kind: "pr" }, text: "tighten the limits section" });
  const artifactByPr = { location: { repo: REPO, prNumber: 5, path: "docs/plan.md", branch: "marathon/doc-b" } };

  it("prompts the revise contract and confirms when the agent's document.revise succeeded", async () => {
    const { deps, transitions, delivered, turnContexts, gatewayRun, countCalls } = makeDeps({
      turnText: "Tightened the limits section.",
      artifactByPr,
      okInvocations: 1,
    });
    await handleGithubMention(deps, prInvocation());

    const req = turnContexts[0]!.request;
    expect(req.instructions).toContain("document_revise");
    expect(req.instructions).toContain('branch "marathon/doc-b"');
    expect(req.instructions).toContain("docs/plan.md");
    // The current doc rides in the untrusted context, not the instructions.
    expect(req.input).toContain("# old doc");

    // Only document.revise counts as "the revision landed": document.update
    // writes to the revision TASK's own branch and can open a different PR,
    // so its success must not be reported as a revision of THIS PR.
    expect(countCalls[0]).toEqual(["document.revise"]);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.summary).toContain("Tightened the limits section.");
    expect(delivered[0]!.summary).toContain("Revised the document on PR #5");
    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);
    expect(gatewayRun).not.toHaveBeenCalled();
  });

  it("reports a visible no-op when the turn made no document write", async () => {
    const { deps, delivered } = makeDeps({
      turnText: "No change is warranted — the limits already match.",
      artifactByPr,
      okInvocations: 0,
    });
    await handleGithubMention(deps, prInvocation());

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.summary).toContain("No revision was committed");
    expect(delivered[0]!.summary).toContain("PR #5 is unchanged");
  });
});
