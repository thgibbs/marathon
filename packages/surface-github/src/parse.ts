import type { NormalizedInvocation } from "@marathon/surface";

export type GithubAction =
  | { kind: "mention"; invocation: NormalizedInvocation }
  | { kind: "merge"; repo: string; number: number; mergeCommitSha?: string }
  | { kind: "push"; repo: string; after?: string; paths: string[] }
  | { kind: "ignore" };

export interface ParseGithubOptions {
  knownAgents?: string[];
}

/** Extract agent + text from a comment body that mentions @marathon. */
function mentionText(body: string, knownAgents?: string[]): { agentName: string | null; text: string } | null {
  if (!/@marathon\b/i.test(body)) return null;
  const after = body.replace(/^[\s\S]*?@marathon\s*/i, "").trim();
  const m = after.match(/^([A-Za-z][\w-]*)\s+([\s\S]+)$/);
  if (m && knownAgents?.includes(m[1]!)) {
    return { agentName: m[1]!, text: m[2]!.trim() };
  }
  return { agentName: null, text: after };
}

/**
 * Classify a GitHub webhook into an action (design.md §7.17):
 *   - issue/PR comment mentioning @marathon -> mention (anchored to repo+number,
 *     plus path/line for review comments)
 *   - a merged pull_request -> merge (the "approve by merge" signal)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyGithubEvent(eventType: string, payload: any, opts: ParseGithubOptions = {}): GithubAction {
  if (eventType === "issue_comment" && payload?.action === "created") {
    const mt = mentionText(payload.comment?.body ?? "", opts.knownAgents);
    if (!mt) return { kind: "ignore" };
    return {
      kind: "mention",
      invocation: {
        surfaceType: "github",
        sourceRef: {
          repo: payload.repository?.full_name,
          number: payload.issue?.number,
          comment_id: payload.comment?.id,
          kind: payload.issue?.pull_request ? "pr" : "issue",
        },
        userExternalId: String(payload.comment?.user?.login ?? payload.sender?.login ?? "unknown"),
        teamExternalId: payload.repository?.owner?.login,
        agentName: mt.agentName,
        text: mt.text,
        eventId: `ic-${payload.comment?.id}`,
      },
    };
  }

  if (eventType === "pull_request_review_comment" && payload?.action === "created") {
    const mt = mentionText(payload.comment?.body ?? "", opts.knownAgents);
    if (!mt) return { kind: "ignore" };
    return {
      kind: "mention",
      invocation: {
        surfaceType: "github",
        sourceRef: {
          repo: payload.repository?.full_name,
          number: payload.pull_request?.number,
          comment_id: payload.comment?.id,
          path: payload.comment?.path,
          line: payload.comment?.line ?? payload.comment?.original_line,
          kind: "pr",
        },
        userExternalId: String(payload.comment?.user?.login ?? "unknown"),
        teamExternalId: payload.repository?.owner?.login,
        agentName: mt.agentName,
        text: mt.text,
        eventId: `prc-${payload.comment?.id}`,
      },
    };
  }

  if (eventType === "pull_request" && payload?.action === "closed" && payload.pull_request?.merged) {
    return {
      kind: "merge",
      repo: payload.repository?.full_name,
      number: payload.pull_request?.number,
      mergeCommitSha: payload.pull_request?.merge_commit_sha,
    };
  }

  if (eventType === "push") {
    const paths = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of (payload?.commits ?? []) as any[]) {
      for (const f of [...(c.added ?? []), ...(c.modified ?? [])]) paths.add(String(f));
    }
    return { kind: "push", repo: payload?.repository?.full_name, after: payload?.after, paths: [...paths] };
  }

  return { kind: "ignore" };
}
