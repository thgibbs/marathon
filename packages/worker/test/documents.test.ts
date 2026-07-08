import type { DeliveryTarget, Task } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { makeDocumentPrRecorder, type DocumentRecorderDb } from "../src/documents";

const EVENT = {
  taskId: "task-1",
  tenantId: "tn1",
  repo: "o/r",
  path: "docs/plan.md",
  branch: "marathon/doc-task-1-docs-plan-md",
  prNumber: 7,
  prUrl: "https://github.com/o/r/pull/7",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tn1",
    agentId: "agent-1",
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.1" },
    deliveryTargets: null,
    status: "running",
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
    ...overrides,
  };
}

function makeDb(task: Task | null, opts: { existingArtifact?: boolean } = {}) {
  const artifacts: Array<Record<string, unknown>> = [];
  const targetUpdates: Array<{ taskId: string; targets: DeliveryTarget[] }> = [];
  const db: DocumentRecorderDb = {
    getTask: async () => task,
    findDocumentArtifactByPr: async () =>
      opts.existingArtifact || artifacts.length > 0 ? ({ id: "artifact-1" } as never) : null,
    recordDocumentArtifact: async (input) => void artifacts.push(input as Record<string, unknown>),
    updateTaskDeliveryTargets: async (taskId, targets) => void targetUpdates.push({ taskId, targets }),
  };
  return { db, artifacts, targetUpdates };
}

describe("makeDocumentPrRecorder (§29.1a — model-driven doc PRs become approvable plans)", () => {
  it("records the artifact and extends the task's targets with the doc PR", async () => {
    const { db, artifacts, targetUpdates } = makeDb(makeTask());
    await makeDocumentPrRecorder(db)(EVENT);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      tenantId: "tn1",
      role: "produced",
      owningTaskId: "task-1",
      owningAgentId: "agent-1",
      location: { repo: "o/r", prNumber: 7, path: "docs/plan.md", branch: EVENT.branch },
    });
    // Targets seed from the task's SOURCE, so the merge-spawned implementation
    // task inherits both the Slack thread and the doc PR (K2).
    expect(targetUpdates).toEqual([
      {
        taskId: "task-1",
        targets: [
          { surfaceType: "slack", ref: { channel: "C1", thread_ts: "1.1" } },
          { surfaceType: "github", ref: { repo: "o/r", number: 7, kind: "pr" } },
        ],
      },
    ]);
  });

  it("is idempotent: a converged retry records no duplicate artifact and dedupes targets", async () => {
    const task = makeTask({
      deliveryTargets: [
        { surfaceType: "slack", ref: { channel: "C1", thread_ts: "1.1" } },
        { surfaceType: "github", ref: { repo: "o/r", number: 7, kind: "pr" } },
      ],
    });
    const { db, artifacts, targetUpdates } = makeDb(task, { existingArtifact: true });
    await makeDocumentPrRecorder(db)(EVENT);
    expect(artifacts).toHaveLength(0);
    expect(targetUpdates[0]!.targets).toHaveLength(2); // no duplicate doc-PR target
  });

  it("still records the artifact when the task row is gone (best-effort ownership)", async () => {
    const { db, artifacts, targetUpdates } = makeDb(null);
    await makeDocumentPrRecorder(db)(EVENT);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ owningTaskId: "task-1", owningAgentId: undefined });
    expect(targetUpdates).toHaveLength(0);
  });
});
