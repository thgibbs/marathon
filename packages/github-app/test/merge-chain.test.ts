import { InMemoryIdempotencyStore, implementationTaskKey, type DeliveryTarget, type Task } from "@marathon/core";
import { DeliveryFanout, type SurfaceAdapter } from "@marathon/surface";
import { describe, expect, it, vi } from "vitest";
import { handleGithubMerge, type GithubAppDeps } from "../src/handlers";

const REPO = "o/r";
const DOC_PR = 5;
const MERGE_SHA = "cafe1234";

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
    ...overrides,
  };
}

// Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
function makeDeps(docTask: Task | null) {
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
  const deps = {
    db: {
      findDocumentArtifactByPr: async () =>
        docTask
          ? { id: "artifact-1", owningTaskId: docTask.id, location: { repo: REPO, prNumber: DOC_PR, path: "docs/plan.md", branch: "marathon/doc-x" } }
          : null,
      getTask: async () => docTask,
      transitionTask: async (id: string, to: string) => void transitions.push([id, to]),
      mergeDocumentArtifactLocation: async (id: string, patch: Record<string, unknown>) =>
        void locationMerges.push({ id, patch }),
    },
    orchestrator: { submit },
    fanout: new DeliveryFanout({ slack: adapter, github: adapter }, new InMemoryIdempotencyStore()),
    tenantId: "tn1",
  } as never as GithubAppDeps;
  return { deps, submit, transitions, progress, locationMerges };
}

describe("handleGithubMerge (K2 task chain)", () => {
  it("spawns an implementation task pinned to the merge commit, chained + inheriting targets", async () => {
    const { deps, submit, transitions, progress, locationMerges } = makeDeps(makeDocTask());
    const handled = await handleGithubMerge(deps, REPO, DOC_PR, MERGE_SHA);
    expect(handled).toBe(true);

    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.sourceTaskId).toBe("doc-task");
    expect(input.idempotencyKey).toBe(implementationTaskKey(REPO, "docs/plan.md", MERGE_SHA));
    expect(input.sourceRef).toMatchObject({
      kind: "implementation",
      baseSha: MERGE_SHA,
      planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: MERGE_SHA },
    });
    // inherited fan-out targets: the originating Slack thread AND the doc PR
    expect(input.deliveryTargets).toEqual([slackOrigin, docPrTarget]);

    // Track 10: the brief carries the plan, base, suggested branch, targets,
    // and the delivery.report_pr contract.
    const brief = String(input.inputText);
    expect(brief).toContain(`docs/plan.md in ${REPO}, merged as ${MERGE_SHA}`);
    expect(brief).toContain("Suggested branch: marathon/docs-plan-");
    expect(brief).toContain("delivery.report_pr EXACTLY ONCE");
    expect(brief).toContain("git.exec");
    expect(brief).toContain("Slack channel C1");

    // Track 10: the merge commit completes the artifact's plan pointer.
    expect(locationMerges).toEqual([{ id: "artifact-1", patch: { mergeCommitSha: MERGE_SHA } }]);

    // the doc task is done: merge is the approval
    expect(transitions).toEqual([["doc-task", "running"], ["doc-task", "completed"]]);

    // progress fanned out to both targets
    expect(progress).toHaveLength(2);
    expect(progress.map((p) => p.ref)).toEqual([slackOrigin.ref, docPrTarget.ref]);
    expect(progress[0]!.message).toContain("docs/plan.md");
  });

  it("adds the doc PR to the targets when the doc task did not record it", async () => {
    const { deps, submit } = makeDeps(makeDocTask({ deliveryTargets: [slackOrigin] }));
    await handleGithubMerge(deps, REPO, DOC_PR, MERGE_SHA);
    const input = submit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.deliveryTargets).toEqual([slackOrigin, docPrTarget]);
  });

  it("does not double-spawn or re-announce on a deduped submit (webhook re-delivery)", async () => {
    const { deps, submit, progress } = makeDeps(makeDocTask({ status: "completed" }));
    submit.mockResolvedValueOnce({ task: { ...makeDocTask(), id: "impl-task" }, deduped: true });
    await handleGithubMerge(deps, REPO, DOC_PR, MERGE_SHA);
    expect(progress).toHaveLength(0);
  });

  it("returns false when the PR is not a produced doc, the task is gone, or the sha is missing", async () => {
    expect(await handleGithubMerge(makeDeps(null).deps, REPO, DOC_PR, MERGE_SHA)).toBe(false);
    const { deps } = makeDeps(makeDocTask());
    expect(await handleGithubMerge(deps, REPO, DOC_PR, undefined)).toBe(false);
  });
});
