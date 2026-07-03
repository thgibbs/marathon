import { isDocTemplate, renderDocument } from "@marathon/surface";
import type { Tool } from "@marathon/tools";
import { repoEgress, repoSource, type GithubClientFactory } from "./tools";

function lines(content: string, start?: number, end?: number): string {
  if (start === undefined && end === undefined) return content;
  const arr = content.split("\n");
  const s = Math.max(1, start ?? 1);
  const e = Math.min(arr.length, end ?? arr.length);
  return arr.slice(s - 1, e).join("\n");
}

/**
 * Document tools backed by GitHub markdown (design.md §7.17, §14.6). Producing
 * or revising a document = working a PR, so create/update/revise are
 * **native review** (§7.8): the call runs, and the human's merge is the
 * approval. Updating re-validates the file's git SHA (stale-SHA rejection).
 */
export function makeDocumentTools(getClient: GithubClientFactory): Tool[] {
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
      const base = typeof input.base === "string" ? input.base : "main";
      const title = typeof input.title === "string" ? input.title : `Add ${path}`;
      const branch = `marathon/doc-${path.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}`;
      // Optionally render the body into a versioned document template (§7.17).
      const body = isDocTemplate(input.template)
        ? renderDocument(input.template, title, String(input.content))
        : String(input.content);
      const { sha } = await client.getRef(repo, `heads/${base}`);
      await client.createBranch(repo, branch, sha);
      await client.putFile(repo, path, body, branch, `docs: add ${path}`);
      const pr = await client.createPullRequest(repo, title, branch, base, "Drafted by Marathon — review and merge to execute.");
      return { content: `opened PR #${pr.number} ${pr.url}`, details: { number: pr.number, url: pr.url, branch, path } };
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
      const base = typeof input.base === "string" ? input.base : "main";
      const branch = `marathon/doc-${path.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}`;
      const { sha } = await client.getRef(repo, `heads/${base}`);
      await client.createBranch(repo, branch, sha);
      await client.putFile(repo, path, String(input.content), branch, `docs: update ${path}`, String(input.sha));
      const pr = await client.createPullRequest(repo, `Update ${path}`, branch, base, "Updated by Marathon.");
      return { content: `opened PR #${pr.number} ${pr.url}`, details: { number: pr.number, url: pr.url, branch, path } };
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
