import type { EffectExecutor } from "@marathon/tools";
import type { GithubClientFactory } from "./tools";

/** The effect type a model-initiated PR merge proposes (design §7.9; Track 9). */
export const GITHUB_MERGE_EFFECT = "github.merge_pull_request";

/**
 * The non-model executor for an approved PR merge (Track 9). Merge is the
 * human's native approval, so a *model-initiated* merge is exactly the kind of
 * direct destructive action that must go propose → approve → execute: the
 * `github.merge_pull_request` tool stays `proposed_effect` (a direct call
 * returns `requires_proposal`), and after a human approves the exact proposal
 * this executor performs it with credentials the model never held.
 *
 * Target shape: `{ repo: "owner/name", number: <pr> }`.
 */
export function makeGithubMergeExecutor(
  getClient: GithubClientFactory,
  opts: { allowedRepos: string[] },
): EffectExecutor {
  return async (effect, ctx) => {
    const repo = effect.target.repo;
    const number = effect.target.number;
    if (typeof repo !== "string" || !opts.allowedRepos.includes(repo)) {
      throw new Error(`merge executor: repo not allowed: ${String(repo)}`);
    }
    if (typeof number !== "number") {
      throw new Error("merge executor: target.number (PR number) is required");
    }
    const client = await getClient({
      taskId: effect.taskId,
      tenantId: effect.tenantId,
      secrets: ctx.secrets,
    });
    const res = await client.mergePullRequest(repo, number);
    if (!res.merged) throw new Error(`merge of ${repo}#${number} was not performed`);
    return {
      summary: `merged ${repo}#${number}${res.sha ? ` (${res.sha.slice(0, 7)})` : ""}`,
      details: { repo, number, sha: res.sha },
    };
  };
}
