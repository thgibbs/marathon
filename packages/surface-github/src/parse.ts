import type { NormalizedInvocation } from "@marathon/surface";

export type GithubAction =
  | { kind: "mention"; invocation: NormalizedInvocation }
  | { kind: "merge"; repo: string; number: number; mergeCommitSha?: string }
  | { kind: "push"; repo: string; after?: string; paths: string[] }
  | {
      /** A submitted PR review (§2b #11) — GitHub's batched "now act" signal. */
      kind: "review";
      repo: string;
      number: number;
      reviewId: number;
      /** Lowercased review state: "changes_requested" | "commented". */
      state: string;
      body: string;
      author: string;
      eventId: string;
    }
  | {
      /**
       * An APPROVING PR review on a doc PR (§29.1a): the native approval in the
       * combined-PR flow. It pins the doc-PR head SHA and spawns the
       * implementation task — the handler verifies Marathon ownership AND that
       * the approver has write access (on public repos anyone can approve).
       */
      kind: "approval";
      repo: string;
      number: number;
      /** The PR head SHA at the review — the SHA the implementation pins to. */
      headSha?: string;
      author: string;
      eventId: string;
    }
  | {
      /**
       * A PR flipped from draft to ready-for-review (§A.3a). For a Marathon code
       * PR this is the trigger for the automatic code review — the handler
       * checks ownership before acting.
       */
      kind: "ready_for_review";
      repo: string;
      number: number;
      eventId: string;
    }
  | {
      /**
       * A PR was just opened (§A.3a). For a Marathon-drafted DOC PR this is the
       * trigger for the automatic design-doc review — surface-agnostic, so a doc
       * drafted from Slack gets reviewed exactly like one drafted from a GitHub
       * mention (the drafting handlers no longer trigger the review inline). The
       * handler gates on doc-artifact ownership; code PRs and human PRs are
       * ignored there.
       */
      kind: "doc_opened";
      repo: string;
      number: number;
      eventId: string;
    }
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
 *   - a submitted APPROVING review -> approval (the §29.1a combined-PR approval
 *     signal; the handler gates it on ownership + the approver's write access)
 *   - a submitted changes_requested/commented review -> review (§2b #11)
 *   - a merged pull_request -> merge (the ship — bookkeeping only, §29.1a)
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
          // §31.4: which reaction endpoint acknowledge() must use — distinct
          // from `kind` above (issue-vs-PR conversation), not inferred from it.
          commentType: "issue",
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
          // §31.4: a PR review (diff-inline) comment reacts via a different
          // endpoint than an issue/PR-conversation comment.
          commentType: "review",
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

  // §2b #11: a SUBMITTED review is GitHub's native batched "I'm done
  // commenting, now act" signal — it triggers WITHOUT an @marathon mention
  // (plain unbatched comments above stay mention-gated: PR threads are
  // mixed-audience). Whether the PR is Marathon-owned is the handler's check.
  if (eventType === "pull_request_review" && payload?.action === "submitted") {
    const review = payload.review;
    // Bot authors never trigger runs (CI bots; and Marathon's own review
    // posts, structurally, once it authors as <app-slug>[bot] — §2b #15).
    if (review?.user?.type === "Bot") return { kind: "ignore" };
    const state = String(review?.state ?? "").toLowerCase();
    // §29.1a (combined-PR flow): an APPROVING review is the approval signal —
    // it pins the doc-PR head SHA and spawns the implementation task (the
    // handler gates it on Marathon ownership + the approver's write access,
    // since on a public repo anyone can submit an approving review).
    if (state === "approved") {
      return {
        kind: "approval",
        repo: payload.repository?.full_name,
        number: payload.pull_request?.number,
        headSha: payload.pull_request?.head?.sha,
        author: String(review?.user?.login ?? payload.sender?.login ?? "unknown"),
        eventId: `rev-${review?.id}`,
      };
    }
    // Only changes_requested / commented reviews act as revision requests.
    if (state !== "changes_requested" && state !== "commented") return { kind: "ignore" };
    return {
      kind: "review",
      repo: payload.repository?.full_name,
      number: payload.pull_request?.number,
      reviewId: Number(review?.id),
      state,
      body: String(review?.body ?? ""),
      author: String(review?.user?.login ?? payload.sender?.login ?? "unknown"),
      eventId: `rev-${review?.id}`,
    };
  }

  if (eventType === "pull_request" && payload?.action === "closed" && payload.pull_request?.merged) {
    // §29.1a (combined-PR flow): a merged doc PR is the SHIP, not the approval
    // — approval already happened via the approving review, and the code was
    // built onto the same PR. The merge webhook records the merge commit and
    // completes bookkeeping; it never spawns implementation (base branch is
    // irrelevant now, so `baseRef` is gone).
    return {
      kind: "merge",
      repo: payload.repository?.full_name,
      number: payload.pull_request?.number,
      mergeCommitSha: payload.pull_request?.merge_commit_sha,
    };
  }

  if (eventType === "pull_request" && payload?.action === "ready_for_review") {
    // §A.3a: the PR just became ready for review — for a Marathon code PR
    // (delivery.report_pr marked it ready on green verification) this triggers
    // the automatic code review. Ownership is verified in the handler.
    return {
      kind: "ready_for_review",
      repo: payload.repository?.full_name,
      number: payload.pull_request?.number,
      eventId: `rfr-${payload.pull_request?.number}-${payload.pull_request?.head?.sha ?? ""}`,
    };
  }

  if (eventType === "pull_request" && payload?.action === "opened") {
    // §A.3a: a PR was just opened — for a Marathon-drafted DOC PR (the gateway
    // opened a DRAFT PR when the agent called document.create) this triggers the
    // automatic design-doc review, no matter which surface asked for the draft.
    // Doc PRs never leave draft before approval, so `opened` — not
    // `ready_for_review` — is their trigger. Ownership is verified in the handler.
    return {
      kind: "doc_opened",
      repo: payload.repository?.full_name,
      number: payload.pull_request?.number,
      eventId: `opened-${payload.pull_request?.number}-${payload.pull_request?.head?.sha ?? ""}`,
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
