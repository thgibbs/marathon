import {
  renderResultText,
  type StructuredResult,
  type SurfaceAdapter,
  type SurfaceMessage,
} from "@marathon/surface";
import type { GithubClient } from "./client";

function ref(r: Record<string, unknown>): { repo: string; number: number } {
  return { repo: String(r.repo), number: Number(r.number) };
}

/** GitHub implementation of surface delivery — posts comment replies on a PR/issue. */
export class GithubDelivery implements SurfaceAdapter {
  constructor(private readonly client: GithubClient) {}

  async acknowledge(r: Record<string, unknown>): Promise<void> {
    const { repo, number } = ref(r);
    await this.client.commentIssue(repo, number, "_on it…_");
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
