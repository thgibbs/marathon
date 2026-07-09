import { InMemoryIdempotencyStore, implementationTaskKey, type DeliveryTarget, type Task } from "@marathon/core";
import type { RepoPermission } from "@marathon/connector-github";
import { DeliveryFanout, type SurfaceAdapter } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { handleGithubApproval, handleGithubMerge, type GithubAppDeps } from "../src/handlers";

const REPO = "o/r";
const DOC_PR = 5;
const DOC_BRANCH = "marathon/doc-x";
const APPROVED_SHA = "cafe1234";

const slackOrigin: DeliveryTarget = { surfaceType: "slack", ref: { channel: "C1", thread_ts: "1.1" } };
const docPrTarget: DeliveryTarget = { surfaceType: "github", ref: { repo: REPO, number: DOC_PR, kind: "pr" } };

function makeDocTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "doc-task",
    tenantId: "tn1",
    agentId: "a1",
    agentVersionId: null,
    invokingUserId: "u1",
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: slackOrigin.ref,
    deliveryTargets: [slackOrigin, docPrTarget],
    status: "waiting_for_approval",
    inputText: "ship rate limiting",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    lastError: null,
    ...overrides,
  };
}

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(
  docTask: Task | null,
  opts: {
    /** The approver's repo permission (§29.1a authorization boundary). Default: write. */
    approverPermission?: RepoPermission;
    /** Set false to deny the agent's token (private repo it can't see). */
    agentSees?: boolean;
    /** A CodeChange already on the doc PR (implementation landed). */
    codeChange?: { prNumber: number } | null;
    /** An implementation task already queued/running for this PR (absorption). */
    activeImplementation?: boolean;
    /** Doc artifact overrides (e.g. missing branch → not Marathon-owned). */
    artifactLocation?: Record<string, unknown> | null;
  } = {},
) {
  const transitions: Array<[string, string]> = [];
  const progress: Array<{ ref: Record<string, unknown>; message: string }> = [];
  const locationMerges: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => ({
    task: { ...makeDocTask(), id: "impl-task", status: "queued", ...input },
    deduped: false,
  }));
  const adapter: SurfaceAdapter = {
    acknowledge: async () => {},
    postProgress: async (ref, message) => void progress.push({ ref, message }),
    deliverResult: async () => {},
  };
  const location =
    opts.artifactLocation === null
      ? {}
      : opts.artifactLocation ?? { repo: REPO, prNumber: DOC_PR, path: "docs/plan.md", branch: DOC_BRANCH };
  const deps = {
    db: {
      findDocumentArtifactByPr: async () =>
        docTask ? { id: "artifact-1", owningTaskId: docTask.id, location } : null,
      findCodeChangeByPr: async () => opts.codeChange ?? null,
      findActiveImplementationTask: async () => (opts.activeImplementation ? makeDocTask({ id: "impl-task" }) : null),
      getTask: async () => docTask,
      transitionTask: async (id: string, to: string) => void transitions.push([id, to]),
      mergeDocumentArtifactLocation: async (id: string, patch: Record<string, unknown>) =>
        void locationMerges.push({ id, patch }),
    },
    orchestrator: { submit },
    fanout: new DeliveryFanout({ slack: adapter, github: adapter }, new InMemoryIdempotencyStore()),
    tenantId: "tn1",
    client: {
      // getRepoAccess reads getRepo (agent visibility) + getUserRepoPermission
      // (the approver's collaborator permission — the authorization boundary).
      getRepo: async () => (opts.agentSees === false ? null : { private: false }),
      getUserRepoPermission: async () => opts.approverPermission ?? "write",
      // Fallback for pinning the head SHA when the webhook omits it.
      getRef: async () => ({ sha: "branch-head-sha" }),
    },
  } as never as GithubAppDeps;
  return { deps, submit, transitions, progress, locationMerges };
}

const approval = (overrides: Partial<{ headSha?: string; author: string; eventId: string }> = {}) => ({
  repo: REPO,
  number: DOC_PR,
  headSha: APPROVED_SHA,
  author: "approver",
  eventId: "rev-99",
  ...overrides,
});

describe("handleGithubApproval (§29.1a combined-PR approval)", () => {
  it("an approving review spawns an implementation task on the SAME branch, chained + inheriting targets", async () => {
    const { deps, submit, transitions, progress, locationMerges } = makeDeps(makeDocTask());
    const handled = await handleGithubApproval(deps, approval());
    expect(handled).toBe(true);

    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.sourceTaskId).toBe("doc-task");
    expect(input.idempotencyKey).toBe(implementationTaskKey(REPO, "docs/plan.md", APPROVED_SHA));
    expect(input.sourceRef).toMatchObject({
      kind: "implementation",
      baseSha: APPROVED_SHA,
      branch: DOC_BRANCH,
      docPrNumber: DOC_PR,
      planRef: { repo: REPO, docPath: "docs/plan.md", approvedSha: APPROVED_SHA },
    });
    // inherited fan-out targets: the originating Slack thread AND the doc PR
    expect(input.deliveryTargets).toEqual([slackOrigin, docPrTarget]);

    // The brief carries the plan, the doc branch, and the delivery contract
    // (same-PR + draft-tracks-verification, both gateway-enforced).
    const brief = String(input.inputText);
    expect(brief).toContain(`docs/plan.md in ${REPO}, approved as ${APPROVED_SHA}`);
    expect(brief).toContain(`branch ${DOC_BRANCH}`);
    expect(brief).toContain(`refuse any PR except #${DOC_PR}`);
    expect(brief).toContain("delivery.report_pr EXACTLY ONCE");
    expect(brief).toContain("Slack channel C1");

    // The approved SHA is recorded on the artifact.
    expect(locationMerges).toEqual([{ id: "artifact-1", patch: { approvedSha: APPROVED_SHA } }]);

    // the doc task is done: the approving review is the approval.
    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);

    // progress fanned out to both targets
    expect(progress).toHaveLength(2);
    expect(progress.map((p) => p.ref)).toEqual([slackOrigin.ref, docPrTarget.ref]);
    expect(progress[0]!.message).toContain("Plan approved by @approver");
  });

  it("adds the doc PR to the targets when the doc task did not record it", async () => {
    const { deps, submit } = makeDeps(makeDocTask({ deliveryTargets: [slackOrigin] }));
    await handleGithubApproval(deps, approval());
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.deliveryTargets).toEqual([slackOrigin, docPrTarget]);
  });

  it("falls back to the branch ref when the webhook omits the head SHA", async () => {
    const { deps, submit } = makeDeps(makeDocTask());
    await handleGithubApproval(deps, approval({ headSha: undefined }));
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.sourceRef).toMatchObject({ baseSha: "branch-head-sha" });
  });

  it("webhook re-delivery converges: no double-spawn, no re-announce (deduped)", async () => {
    const { deps, submit, progress } = makeDeps(makeDocTask({ status: "completed" }));
    submit.mockResolvedValueOnce({ task: { ...makeDocTask(), id: "impl-task" }, deduped: true });
    await handleGithubApproval(deps, approval());
    expect(progress).toHaveLength(0);
  });

  it("returns false when the PR is not a Marathon-owned doc PR", async () => {
    // No artifact at all.
    expect(await handleGithubApproval(makeDeps(null).deps, approval())).toBe(false);
    // Artifact without a live doc branch (not a drafted doc PR).
    const noBranch = makeDeps(makeDocTask(), { artifactLocation: { repo: REPO, prNumber: DOC_PR, path: "docs/plan.md" } });
    expect(await handleGithubApproval(noBranch.deps, approval())).toBe(false);
    expect(noBranch.submit).not.toHaveBeenCalled();
  });

  it("consumes silently (no task) when a CodeChange already exists for the PR", async () => {
    // Implementation already landed → an approving review is just pre-merge code
    // approval, not a build trigger.
    const { deps, submit } = makeDeps(makeDocTask(), { codeChange: { prNumber: DOC_PR } });
    expect(await handleGithubApproval(deps, approval())).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("absorbs while an implementation is already queued/running for the PR", async () => {
    // The GitHub mirror of Slack's "chatter while running": a re-approval —
    // even at a NEW head SHA — never double-spawns while a build is in flight.
    const { deps, submit } = makeDeps(makeDocTask(), { activeImplementation: true });
    expect(await handleGithubApproval(deps, approval({ headSha: "newer-sha" }))).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("is SILENT and spawns nothing when the approver lacks write access (§7.17 authz boundary)", async () => {
    // On a public repo anyone can approve; only write access may trigger a build.
    const readOnly = makeDeps(makeDocTask(), { approverPermission: "read" });
    expect(await handleGithubApproval(readOnly.deps, approval())).toBe(true);
    expect(readOnly.submit).not.toHaveBeenCalled();

    // admin approvers are allowed.
    const adminApprover = makeDeps(makeDocTask(), { approverPermission: "admin" });
    expect(await handleGithubApproval(adminApprover.deps, approval())).toBe(true);
    expect(adminApprover.submit).toHaveBeenCalledTimes(1);
  });
});

describe("handleGithubMerge (§29.1a: the ship, not the approval)", () => {
  it("records the merge commit and completes an open doc task — but spawns NOTHING", async () => {
    const { deps, submit, transitions, locationMerges } = makeDeps(makeDocTask());
    const handled = await handleGithubMerge(deps, REPO, DOC_PR, "merge-sha");
    expect(handled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(locationMerges).toEqual([{ id: "artifact-1", patch: { mergeCommitSha: "merge-sha" } }]);
    // A doc PR merged while still waiting is "shipped without a build": complete
    // the doc task, but never spawn implementation (approval must be explicit).
    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);
  });

  it("does not re-complete an already-terminal doc task", async () => {
    const { deps, transitions } = makeDeps(makeDocTask({ status: "completed" }));
    await handleGithubMerge(deps, REPO, DOC_PR, "merge-sha");
    expect(transitions).toEqual([]);
  });

  it("returns false when the PR is not a produced doc / the task is gone", async () => {
    expect(await handleGithubMerge(makeDeps(null).deps, REPO, DOC_PR, "merge-sha")).toBe(false);
  });
});
