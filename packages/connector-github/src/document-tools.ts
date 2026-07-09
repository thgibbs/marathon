import { isDocTemplate, renderDocument } from "@marathon/surface";
import type { Tool } from "@marathon/tools";
import type { GithubClient } from "./client";
import { repoEgress, repoSource, type GithubClientFactory } from "./tools";

function lines(content: string, start?: number, end?: number): string {
  if (start === undefined && end === undefined) return content;
  const arr = content.split("\n");
  const s = Math.max(1, start ?? 1);
  const e = Math.min(arr.length, end ?? arr.length);
  return arr.slice(s - 1, e).join("\n");
}

/**
 * Deterministic document branch (Track 10): `marathon/doc-<task>-<slug(path)>`.
 * The task id is the idempotency anchor — a webhook retry of the same task
 * converges on one branch/PR instead of minting a timestamped duplicate, while
 * distinct tasks writing the same path never collide.
 */
export function docBranchForTask(taskId: string, path: string): string {
  const slug =
    path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc";
  return `marathon/doc-${taskId}-${slug}`;
}

/**
 * Converge-or-create for a doc branch + PR (Track 10): if the deterministic
 * branch already has an open PR (a webhook retry re-ran the tool), commit the
 * content onto that branch and return the existing PR; otherwise create the
 * branch from base and open a new PR.
 */
async function upsertDocPr(
  client: GithubClient,
  args: { repo: string; path: string; branch: string; base: string; title: string; body: string; commitMessage: string; prBody: string; fileSha?: string; draft?: boolean },
): Promise<{ number: number; url: string; converged: boolean }> {
  const { repo, path, branch, base } = args;
  // Retry convergence first: the deterministic branch already has an open PR →
  // converge onto it and reuse the PR.
  const existing = await client.findPullRequestByHead(repo, branch);
  if (existing) {
    const current = await client.readFileWithSha(repo, path, branch).catch(() => null);
    // A replay of the same accepted write: nothing to commit.
    if (current && current.content === args.body) {
      return { number: existing.number, url: existing.url, converged: true };
    }
    // Stale-SHA rejection with retry awareness (Track 10): a caller-supplied
    // sha (document.update) legitimately trails the branch after the first
    // accepted call moved the file — so accept a sha matching the branch tip
    // OR the current base file (what the caller actually read), and reject
    // only when it matches neither (a truly stale read).
    if (args.fileSha && args.fileSha !== current?.sha) {
      const baseFile = await client.readFileWithSha(repo, path, base).catch(() => null);
      if (args.fileSha !== baseFile?.sha) {
        throw new Error(`document update rejected: stale sha for ${path} — re-read the document and retry`);
      }
    }
    await client.putFile(repo, path, args.body, branch, args.commitMessage, current?.sha);
    return { number: existing.number, url: existing.url, converged: true };
  }
  const { sha } = await client.getRef(repo, `heads/${base}`);
  try {
    await client.createBranch(repo, branch, sha);
  } catch (e) {
    // Branch exists but its PR is gone (closed/merged): repoint it at base and reuse it.
    if (!/422|already exists/i.test(String(e))) throw e;
    await client.updateRef(repo, branch, sha, true);
  }
  await client.putFile(repo, path, args.body, branch, args.commitMessage, args.fileSha);
  // §29.1a (combined-PR flow): doc PRs open as DRAFTs against the default
  // branch. The approving review (not the merge) is the approval; the BUILD
  // agent then pushes its code onto this same branch and marks the PR ready.
  const pr = await client.createPullRequest(repo, args.title, branch, base, args.prBody, { draft: args.draft ?? false });
  return { number: pr.number, url: pr.url, converged: false };
}

/** What `onDocumentPr` hears after a doc PR is opened or converged on. */
export interface DocumentPrEvent {
  taskId: string;
  tenantId: string;
  repo: string;
  path: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  /** True when a retry converged on an existing branch/PR instead of creating one. */
  converged: boolean;
}

export interface DocumentToolsOptions {
  /**
   * The configured base branch for document PRs — the default branch (§29.1a,
   * combined-PR flow: doc PRs are drafts against the default branch, approved
   * by an approving review and shipped by merge). When set it is AUTHORITATIVE
   * (enforcement by construction, §7.8): a model-supplied `base` cannot
   * retarget doc PRs at another branch. When unset, `input.base` is honored
   * (default "main").
   */
  docBase?: string;
  /**
   * Called after `document.create`/`document.update` opens (or converges on)
   * a doc PR. Load-bearing for model-driven surfaces (the Slack loop): the
   * caller records the `DocumentArtifact` + delivery target the merge webhook
   * needs to recognize the PR as an approvable plan — without it, merging the
   * plan would be ignored. Awaited; a failure fails the tool call, and the
   * agent's retry converges on the same branch/PR.
   */
  onDocumentPr?: (event: DocumentPrEvent) => Promise<void> | void;
}

/**
 * Document tools backed by GitHub markdown (design.md §7.17, §14.6). Producing
 * or revising a document = working a PR, so create/update/revise are
 * **native review** (§7.8). In the combined-PR flow (§29.1a) `document.create`
 * (and `document.update` when it opens a PR) opens a DRAFT PR against the
 * default branch; the human's APPROVING REVIEW is the approval (it spawns the
 * implementation), and the eventual merge ships design + code together.
 * Updating re-validates the file's git SHA (stale-SHA rejection).
 */
export function makeDocumentTools(getClient: GithubClientFactory, opts: DocumentToolsOptions = {}): Tool[] {
  const docBase = (input: Record<string, unknown>): string =>
    opts.docBase ?? (typeof input.base === "string" ? input.base : "main");
  const readRegion: Tool = {
    name: "document.read_region",
    description: "Read a markdown file (optionally a line range) from a repo.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
    defaultMode: "autonomous",
    sources: repoSource,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.path !== "string") return "path is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const file = await client.readFile(String(input.repo), String(input.path), typeof input.ref === "string" ? input.ref : undefined);
      return {
        content: lines(file.content, input.startLine as number | undefined, input.endLine as number | undefined),
        details: { path: file.path },
      };
    },
  };

  const create: Tool = {
    name: "document.create",
    description: "Create a markdown document by opening a pull request.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "native_review",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.path !== "string") return "path is required";
      if (typeof input.content !== "string") return "content is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const repo = String(input.repo);
      const path = String(input.path);
      const base = docBase(input);
      const title = typeof input.title === "string" ? input.title : `Add ${path}`;
      // Deterministic per (task, path) so webhook retries converge (Track 10).
      const branch = docBranchForTask(ctx.taskId, path);
      // Optionally render the body into a versioned document template (§7.17).
      const body = isDocTemplate(input.template)
        ? renderDocument(input.template, title, String(input.content))
        : String(input.content);
      const pr = await upsertDocPr(client, {
        repo,
        path,
        branch,
        base,
        title,
        body,
        commitMessage: `docs: add ${path}`,
        prBody: "Drafted by Marathon — review and submit an approving review to execute.",
        // §29.1a: a design-doc PR opens as a draft; the approving review starts
        // the build, which marks it ready for review before merge.
        draft: true,
      });
      await opts.onDocumentPr?.({
        taskId: ctx.taskId,
        tenantId: ctx.tenantId,
        repo,
        path,
        branch,
        prNumber: pr.number,
        prUrl: pr.url,
        converged: pr.converged,
      });
      return {
        content: `${pr.converged ? "updated" : "opened"} PR #${pr.number} ${pr.url}`,
        details: { number: pr.number, url: pr.url, branch, path, converged: pr.converged },
      };
    },
  };

  const update: Tool = {
    name: "document.update",
    description: "Update a markdown document via a pull request (re-validates the file SHA).",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "native_review",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.path !== "string") return "path is required";
      if (typeof input.content !== "string") return "content is required";
      if (typeof input.sha !== "string") return "sha (current file sha) is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const repo = String(input.repo);
      const path = String(input.path);
      const base = docBase(input);
      const branch = docBranchForTask(ctx.taskId, path);
      const pr = await upsertDocPr(client, {
        repo,
        path,
        branch,
        base,
        title: `Update ${path}`,
        body: String(input.content),
        commitMessage: `docs: update ${path}`,
        prBody: "Updated by Marathon — review and submit an approving review to execute.",
        fileSha: String(input.sha),
        // §29.1a: if this update opens a NEW doc PR, it too is a draft awaiting
        // an approving review (a converged retry leaves the existing PR's state
        // untouched).
        draft: true,
      });
      await opts.onDocumentPr?.({
        taskId: ctx.taskId,
        tenantId: ctx.tenantId,
        repo,
        path,
        branch,
        prNumber: pr.number,
        prUrl: pr.url,
        converged: pr.converged,
      });
      return {
        content: `${pr.converged ? "updated" : "opened"} PR #${pr.number} ${pr.url}`,
        details: { number: pr.number, url: pr.url, branch, path, converged: pr.converged },
      };
    },
  };

  const revise: Tool = {
    name: "document.revise",
    description: "Revise an existing document by committing to its PR branch (updates the open PR).",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "native_review",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.path !== "string") return "path is required";
      if (typeof input.content !== "string") return "content is required";
      if (typeof input.branch !== "string") return "branch is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const repo = String(input.repo);
      const path = String(input.path);
      const branch = String(input.branch);
      // Rebase-before-write (M9 #6): commit against the latest SHA; if a concurrent
      // edit lands between read and write (409), re-read and retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await client.readFileWithSha(repo, path, branch);
        try {
          await client.putFile(repo, path, String(input.content), branch, `docs: revise ${path}`, current.sha);
          return { content: `revised ${path} on ${branch}`, details: { path, branch, rebased: attempt > 0 } };
        } catch (e) {
          if (attempt === 0 && /409|stale/i.test(String(e))) continue;
          throw e;
        }
      }
      throw new Error("document.revise: rebase retry exhausted");
    },
  };

  const comment: Tool = {
    name: "document.comment",
    description: "Comment on a PR or issue.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.number !== "number") return "number is required";
      if (typeof input.body !== "string") return "body is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const res = await client.commentIssue(String(input.repo), Number(input.number), String(input.body));
      return { content: `commented (id ${res.id})`, details: res };
    },
  };

  const replyToComment: Tool = {
    name: "document.reply_to_comment",
    description: "Reply to a pull-request review comment (threaded under it).",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo is required";
      if (typeof input.number !== "number") return "number (PR number) is required";
      if (typeof input.commentId !== "number") return "commentId is required";
      if (typeof input.body !== "string") return "body is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const res = await client.replyToReviewComment(String(input.repo), Number(input.number), Number(input.commentId), String(input.body));
      return { content: `replied (id ${res.id})`, details: res };
    },
  };

  return [readRegion, create, update, revise, comment, replyToComment];
}
