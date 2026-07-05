import { mergeDeliveryTargets, type DeliveryTarget, type DocumentArtifact, type Id, type Task } from "@marathon/core";

/**
 * Plan-artifact bookkeeping for model-driven doc PRs (§29.1a). The GitHub
 * app's inline mention flow records its own artifact; on surfaces where the
 * MODEL opens the doc PR through the gateway (the Slack loop), this is the
 * `onDocumentPr` hook that persists what the merge webhook needs — without
 * it, a plan drafted from Slack would merge into the plans branch and be
 * silently ignored (no artifact → no approval → no implementation task).
 */

/** What the recorder needs from the database (`Database` satisfies this). */
export interface DocumentRecorderDb {
  getTask(taskId: Id): Promise<Task | null>;
  findDocumentArtifactByPr(tenantId: Id, repo: string, prNumber: number): Promise<DocumentArtifact | null>;
  recordDocumentArtifact(input: {
    tenantId: Id;
    location: Record<string, unknown>;
    role: "produced" | "watched";
    owningTaskId?: Id;
    owningAgentId?: Id;
    title?: string;
  }): Promise<unknown>;
  updateTaskDeliveryTargets(taskId: Id, targets: DeliveryTarget[]): Promise<void>;
}

/**
 * Build the `onDocumentPr` hook: record the `DocumentArtifact` (idempotent —
 * a converged retry finds the existing row) and extend the task's delivery
 * targets with the doc PR, seeding them from the task's source so the
 * merge-spawned implementation task inherits BOTH the originating thread and
 * the doc PR (K2).
 */
export function makeDocumentPrRecorder(db: DocumentRecorderDb) {
  return async (event: {
    taskId: string;
    tenantId: string;
    repo: string;
    path: string;
    branch: string;
    prNumber: number;
    prUrl: string;
  }): Promise<void> => {
    const task = await db.getTask(event.taskId);

    const existing = await db.findDocumentArtifactByPr(event.tenantId, event.repo, event.prNumber);
    if (!existing) {
      await db.recordDocumentArtifact({
        tenantId: event.tenantId,
        location: { repo: event.repo, prNumber: event.prNumber, path: event.path, branch: event.branch },
        role: "produced",
        owningTaskId: event.taskId,
        owningAgentId: task?.agentId ?? undefined,
        title: event.path,
      });
    }

    if (task) {
      const seed: DeliveryTarget[] =
        task.deliveryTargets ?? [{ surfaceType: task.sourceType, ref: task.sourceRef }];
      await db.updateTaskDeliveryTargets(
        task.id,
        mergeDeliveryTargets(seed, {
          surfaceType: "github",
          ref: { repo: event.repo, number: event.prNumber, kind: "pr" },
        }),
      );
    }
  };
}
