import type { Tool } from "@marathon/tools";
import { repoEgress, type GithubClientFactory } from "./tools";

/**
 * A reviewer agent's verdict on a pull request (codex-impl.md §A.3a). The
 * verdict is a MACHINE signal (it drives the automated kickback loop — a
 * `changes_requested` bounces the PR back to the owning agent to revise, capped
 * per PR; an `approved` never merges), while the summary is the human-readable
 * review posted as a PR comment.
 */
export type ReviewVerdict = "approved" | "changes_requested";

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["approved", "changes_requested"];

/** Marker line prefixed to the posted comment so humans (and tests) can spot an automated review. */
export const REVIEW_COMMENT_MARKER = "🔎 Automated review";

export interface ReviewReportOptions {
  getClient: GithubClientFactory;
  /**
   * Called after the comment posts, with the structured verdict — this is what
   * the auto-kickback loop (§A.3a) reads to decide whether to bounce the PR
   * back to its owning agent. Best-effort: a hook failure must not fail the
   * review that was already posted.
   */
  onReviewed?(info: {
    taskId: string;
    repo: string;
    prNumber: number;
    verdict: ReviewVerdict;
    summary: string;
  }): Promise<void> | void;
}

function isVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

/** Render the PR comment a reviewer posts: a marked header + the verdict + the summary. */
export function renderReviewComment(verdict: ReviewVerdict, summary: string): string {
  const label = verdict === "approved" ? "APPROVED" : "CHANGES REQUESTED";
  return `${REVIEW_COMMENT_MARKER} — **${label}**\n\n${summary.trim()}`;
}

/**
 * `review.report` — a reviewer agent's single terminal step (the review-side
 * analogue of `delivery.report_pr`, §A.3a). It posts the summary as a PR
 * comment and records the structured verdict for the kickback loop. It is
 * comment-only by design (no formal GitHub APPROVE/REQUEST_CHANGES verdict), so
 * a reviewer can never trigger a build or merge — those stay human (§29.1a).
 */
export function makeReviewReportTool(opts: ReviewReportOptions): Tool {
  return {
    name: "review.report",
    description:
      "Report your review of a pull request. Call this exactly once when you are done reviewing: pass the " +
      "repo, the PR number, your verdict ('approved' or 'changes_requested'), and a concise summary of your " +
      "findings. Marathon posts the summary as a PR comment and records your verdict. This does NOT approve, " +
      "request changes as a formal GitHub review, merge, or trigger a build — a human still owns those.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    // The review lands as a comment on the PR inside the tenant — internal egress.
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string" || !input.repo.trim()) return "repo is required";
      if (typeof input.number !== "number") return "number (the PR number) is required";
      if (!isVerdict(input.verdict)) return "verdict must be 'approved' or 'changes_requested'";
      if (typeof input.summary !== "string" || !input.summary.trim()) return "summary is required";
      return null;
    },
    async execute(input, ctx) {
      const repo = String(input.repo);
      const prNumber = Number(input.number);
      const verdict = input.verdict as ReviewVerdict;
      const summary = String(input.summary);
      const client = await opts.getClient(ctx);
      const res = await client.commentIssue(repo, prNumber, renderReviewComment(verdict, summary));
      // Best-effort (§31.8 pattern): the review is already public — a recording
      // failure must not fail the tool call it is reporting on.
      try {
        await opts.onReviewed?.({ taskId: ctx.taskId, repo, prNumber, verdict, summary });
      } catch (e) {
        console.warn("[review] failed to record verdict for the kickback loop:", e);
      }
      return { content: `reviewed PR #${prNumber} (${verdict})`, details: { id: res.id, verdict } };
    },
  };
}
