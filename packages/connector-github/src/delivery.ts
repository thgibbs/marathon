import {
  renderResultText,
  type StructuredResult,
  type SurfaceAdapter,
  type SurfaceMessage,
} from "@marathon/surface";
import type { GithubClient } from "./client";

/** GitHub's :+1: reaction content — the ack signal (§31.3). */
const ACK_REACTION = "+1";

function ref(r: Record<string, unknown>): { repo: string; number: number } {
  return { repo: String(r.repo), number: Number(r.number) };
}

/** The triggering comment's identity for reaction targeting (§31.4). */
function commentRef(r: Record<string, unknown>): { commentId?: number; commentType?: "issue" | "review" } {
  const commentId = typeof r.commentId === "number" ? r.commentId : undefined;
  const commentType = r.commentType === "review" ? "review" : r.commentType === "issue" ? "issue" : undefined;
  return { commentId, commentType };
}

/** GitHub implementation of surface delivery — posts comment replies on a PR/issue. */
export class GithubDelivery implements SurfaceAdapter {
  constructor(private readonly client: GithubClient) {}

  /**
   * React :+1: to the triggering comment (§31.3) instead of posting text.
   * `commentType` picks the endpoint (§31.4: issue/PR-conversation comments
   * and PR review comments are different GitHub objects). No-op when the ref
   * carries no comment identity (e.g. a review-triggered mention with no
   * single triggering comment). Best-effort (§31.8): swallow failures.
   */
  async acknowledge(r: Record<string, unknown>): Promise<void> {
    const { repo } = ref(r);
    const { commentId, commentType } = commentRef(r);
    if (commentId === undefined) return;
    try {
      if (commentType === "review") {
        await this.client.addReviewCommentReaction(repo, commentId, ACK_REACTION);
      } else {
        await this.client.addIssueCommentReaction(repo, commentId, ACK_REACTION);
      }
    } catch {
      // best-effort signal (§31.8) — never fail the task
    }
  }

  async postProgress(r: Record<string, unknown>, message: string): Promise<void> {
    const { repo, number } = ref(r);
    await this.client.commentIssue(repo, number, message);
  }

  async deliverResult(r: Record<string, unknown>, result: StructuredResult): Promise<void> {
    const { repo, number } = ref(r);
    await this.client.commentIssue(repo, number, renderResultText(result));
  }

  /** Issue/PR comment history for prompt assembly (Track 12, §7.18); untrusted — fence it. */
  async loadContext(r: Record<string, unknown>, opts?: { limit?: number }): Promise<SurfaceMessage[]> {
    const { repo, number } = ref(r);
    const comments = await this.client.listIssueComments(repo, number, opts?.limit ?? 50);
    return comments.map((c) => ({ author: c.author, text: c.body, ts: c.createdAt }));
  }
}
