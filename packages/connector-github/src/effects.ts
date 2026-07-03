import type { EffectExecutor } from "@marathon/tools";
import type { GithubClientFactory } from "./tools";

/** The effect type a model-initiated PR merge proposes (design §7.9; Track 9). */
export const GITHUB_MERGE_EFFECT = "github.merge_pull_request";

const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];
const MERGE_PAYLOAD_KEYS = new Set(["repo", "number", "method"]);

/** The exact merge mutation a reviewer approves (§7.9): nothing outside this shape executes. */
export interface GithubMergePayload {
  repo: string;
  number: number;
  method?: MergeMethod;
}

function isMergeMethod(v: unknown): v is MergeMethod {
  return typeof v === "string" && (MERGE_METHODS as readonly string[]).includes(v);
}

/**
 * Narrow an approved proposal's payload to the supported merge shape. Approval
 * binds to the payload (Track 9), so the executor runs *from* it — and refuses
 * any field it does not understand, so the reviewed artifact is exactly the
 * executed artifact.
 */
export function parseGithubMergePayload(payload: Record<string, unknown>): GithubMergePayload {
  const unknown = Object.keys(payload).filter((k) => !MERGE_PAYLOAD_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`merge executor: unsupported payload field(s) [${unknown.join(", ")}] — refusing to execute more than was reviewed`);
  }
  if (typeof payload.repo !== "string") throw new Error("merge executor: payload.repo is required");
  if (typeof payload.number !== "number") throw new Error("merge executor: payload.number (PR number) is required");
  if (payload.method !== undefined && !isMergeMethod(payload.method)) {
    throw new Error(`merge executor: payload.method must be one of ${MERGE_METHODS.join("|")}`);
  }
  return { repo: payload.repo, number: payload.number, method: payload.method };
}

/**
 * The non-model executor for an approved PR merge (Track 9). Merge is the
 * human's native approval, so a *model-initiated* merge is exactly the kind of
 * direct destructive action that must go propose → approve → execute: the
 * `github.merge_pull_request` tool stays `proposed_effect` (a direct call
 * returns `requires_proposal`), and after a human approves the exact proposal
 * this executor performs it with credentials the model never held.
 *
 * Payload shape (what the reviewer approves and what runs):
 * `{ repo: "owner/name", number: <pr>, method?: "merge"|"squash"|"rebase" }`;
 * the target must name the same repo/PR.
 */
export function makeGithubMergeExecutor(
  getClient: GithubClientFactory,
  opts: { allowedRepos: string[] },
): EffectExecutor {
  return async (effect, ctx) => {
    const payload = parseGithubMergePayload(effect.payload);
    if (!opts.allowedRepos.includes(payload.repo)) {
      throw new Error(`merge executor: repo not allowed: ${payload.repo}`);
    }
    if (effect.target.repo !== payload.repo || effect.target.number !== payload.number) {
      throw new Error("merge executor: the proposal's target does not match its payload — refusing to execute");
    }
    const client = await getClient({
      taskId: effect.taskId,
      tenantId: effect.tenantId,
      secrets: ctx.secrets,
    });
    const res = await client.mergePullRequest(payload.repo, payload.number, { method: payload.method });
    if (!res.merged) throw new Error(`merge of ${payload.repo}#${payload.number} was not performed`);
    return {
      summary: `merged ${payload.repo}#${payload.number}${res.sha ? ` (${res.sha.slice(0, 7)})` : ""}`,
      details: { repo: payload.repo, number: payload.number, method: payload.method, sha: res.sha },
    };
  };
}
