import { mergeDeliveryTargets, type DeliveryTarget, type DocumentArtifact, type Id, type Task } from "@marathon/core";

/**
 * Plan-artifact bookkeeping for model-driven doc PRs (§29.1a). The GitHub
 * app's inline mention flow records its own artifact; on surfaces where the
 * MODEL opens the doc PR through the gateway (the Slack loop), this is the
 * `onDocumentPr` hook that persists what the approval handler needs — without
 * it, an approving review on a plan drafted from Slack would find no artifact
 * (no owning task → no approval → no implementation task).
 */

/**
 * The doc-task tool contracts (§2b #16), mirroring the BUILD contract (§29.4):
 * the document body is delivered ONLY as a `document.*` tool argument through
 * the Tool Gateway — the turn's text is just the in-thread reply and is never
 * committed. Tool names use the model-facing form (dots → underscores).
 * Shared by the GitHub mention flows and the Slack doc-draft path.
 */
export function docDraftContract(o: { repo: string; path: string }): string {
  return (
    `This task delivers a design document. Submit it by calling the document_create tool ` +
    `exactly once, with repo "${o.repo}", path "${o.path}", a concise "title" for the pull ` +
    `request, and the COMPLETE markdown document as the "content" argument. The document ` +
    `reaches review ONLY through that tool call — text in your reply is never committed ` +
    `anywhere. After the tool call, finish with a short reply for the requester's thread ` +
    `(a sentence or two on what you drafted); never include the document body in the reply. ` +
    `If you cannot produce a document, make no document tool call and explain why in your reply.`
  );
}

export function docReviseContract(o: { repo: string; path: string; branch: string }): string {
  return (
    `This task revises the existing document ${o.path}, under review on pull-request branch ` +
    `"${o.branch}" (its current content is in the untrusted context). Apply the requested ` +
    `changes and submit the COMPLETE revised markdown by calling the document_revise tool ` +
    `exactly once, with repo "${o.repo}", path "${o.path}", branch "${o.branch}", and the full ` +
    `revised document as the "content" argument. The revision lands ONLY through that tool ` +
    `call — text in your reply is never committed anywhere. After the tool call, finish with a ` +
    `short reply for the PR thread; never include the document body in the reply. If no change ` +
    `is warranted, make no document tool call and explain why in your reply.`
  );
}

/** A stable, path-safe slug for a drafted document's filename. */
export function docPathSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc";
}

/**
 * The durable job kind for the automatic design-doc review (§A.3a #19). The
 * surface that drafts a doc PR enqueues one job AFTER the `DocumentArtifact` is
 * committed — a race-free, surface-agnostic trigger: whichever process opened
 * the PR (Slack worker or the GitHub app) enqueues, and the GitHub app leases
 * and runs the review. It replaces triggering off the `pull_request.opened`
 * webhook, which could beat the artifact write and silently drop the review.
 */
export const DESIGN_REVIEW_JOB_KIND = "design_review";

/**
 * Idempotency key for a doc PR's design-review job — dedupes redeliveries and
 * repeated `document.create` calls down to exactly one review per PR (PR numbers
 * are unique and never reused, so the key never collides across distinct docs).
 */
export function designReviewJobKey(repo: string, prNumber: number): string {
  return `design-review:${repo}:${prNumber}`;
}

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

/** Optional hooks for the doc-PR recorder. */
export interface DocumentPrRecorderHooks {
  /**
   * Fired once, right AFTER a NEW `produced` doc-PR artifact is committed (§A.3a
   * #19) — the race-free point to trigger the automatic design review. NOT
   * called on a converged retry (the artifact already existed), so a revise or
   * re-push never spawns a duplicate review. Typically enqueues a
   * `DESIGN_REVIEW_JOB_KIND` job; a throw here propagates (the doc-PR tool call
   * fails loudly) rather than silently losing the trigger.
   */
  onProduced?: (e: { tenantId: string; repo: string; prNumber: number; owningTaskId: string }) => Promise<void> | void;
}

/**
 * Build the `onDocumentPr` hook: record the `DocumentArtifact` (idempotent —
 * a converged retry finds the existing row) and extend the task's delivery
 * targets with the doc PR, seeding them from the task's source so the
 * merge-spawned implementation task inherits BOTH the originating thread and
 * the doc PR (K2). On a NEW produced artifact it also fires `onProduced` — the
 * durable, race-free design-review trigger (the artifact is committed first).
 */
export function makeDocumentPrRecorder(db: DocumentRecorderDb, hooks: DocumentPrRecorderHooks = {}) {
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
      // §A.3a #19: the artifact is now durably committed — signal the reviewer.
      // Enqueued AFTER the write, so the review job can never observe a missing
      // artifact (the webhook-trigger race this replaces). Surface-agnostic: the
      // same enqueue runs whether a Slack worker or the GitHub app opened the PR.
      await hooks.onProduced?.({
        tenantId: event.tenantId,
        repo: event.repo,
        prNumber: event.prNumber,
        owningTaskId: event.taskId,
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
