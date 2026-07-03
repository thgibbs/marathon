import type { EgressTarget, SourceRead, Tool, ToolContext, ToolInput } from "@marathon/tools";
import { HttpGithubClient, type GithubClient } from "./client";

export type GithubClientFactory = (ctx: ToolContext) => GithubClient | Promise<GithubClient>;

/**
 * Repo content enters the source ledger as `company_viewable` — the kernel's
 * initial calibration (§7.8): all repos flow to any internal audience until a
 * customer needs finer tiers.
 */
export function repoSource(input: ToolInput): SourceRead[] {
  return typeof input.repo === "string"
    ? [{ source: `github:${input.repo}`, sensitivity: "company_viewable" }]
    : [];
}

/** A write landing in the repo's issues/PRs: internal, tenant-visible egress. */
export function repoEgress(input: ToolInput): EgressTarget | null {
  return typeof input.repo === "string"
    ? { destination: `github:${input.repo}`, audience: "tenant", external: false }
    : null;
}

/** Read-only GitHub tools, parameterized over a client (real or fixtures). */
export function makeGithubReadTools(getClient: GithubClientFactory): Tool[] {
  const readFile: Tool = {
    name: "github.read_file",
    description: "Read a file from a GitHub repository.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
    defaultMode: "autonomous",
    sources: repoSource,
    validate(input) {
      if (typeof input.repo !== "string") return "repo (owner/name) is required";
      if (typeof input.path !== "string") return "path is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const file = await client.readFile(
        String(input.repo),
        String(input.path),
        typeof input.ref === "string" ? input.ref : undefined,
      );
      return { content: file.content, details: { path: file.path } };
    },
  };

  const listContents: Tool = {
    name: "github.list_contents",
    description: "List the contents of a directory in a GitHub repository.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
    defaultMode: "autonomous",
    sources: repoSource,
    validate(input) {
      if (typeof input.repo !== "string") return "repo (owner/name) is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const entries = await client.listContents(
        String(input.repo),
        typeof input.path === "string" ? input.path : "",
        typeof input.ref === "string" ? input.ref : undefined,
      );
      return {
        content: entries.map((e) => `${e.type}\t${e.path}`).join("\n"),
        details: { entries },
      };
    },
  };

  return [readFile, listContents];
}

/**
 * GitHub write tools. Creating/commenting is reversible, tenant-audience
 * egress -> autonomous (§7.8); merge is irreversible and never a direct tool —
 * it is the *native approval* a human performs, and any model-initiated merge
 * would be a Proposed Effect (§7.9).
 */
export function makeGithubWriteTools(getClient: GithubClientFactory): Tool[] {
  const createIssue: Tool = {
    name: "github.create_issue",
    description: "Create an issue in a GitHub repository.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo (owner/name) is required";
      if (typeof input.title !== "string") return "title is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const res = await client.createIssue(
        String(input.repo),
        String(input.title),
        typeof input.body === "string" ? input.body : undefined,
      );
      return { content: `created issue #${res.number} ${res.url}`, details: res };
    },
  };

  const commentIssue: Tool = {
    name: "github.comment_issue",
    description: "Comment on a GitHub issue or pull request.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    egress: repoEgress,
    validate(input) {
      if (typeof input.repo !== "string") return "repo (owner/name) is required";
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

  const mergePr: Tool = {
    name: "github.merge_pull_request",
    description: "Merge a pull request (high-risk: merge is the human's native approval).",
    riskAxes: { reversible: false, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "proposed_effect",
    validate(input) {
      if (typeof input.repo !== "string") return "repo (owner/name) is required";
      if (typeof input.number !== "number") return "number (PR) is required";
      return null;
    },
    async execute(input, ctx) {
      const client = await getClient(ctx);
      const res = await client.mergePullRequest(String(input.repo), Number(input.number));
      return { content: res.merged ? `merged PR #${input.number}` : "merge failed", details: res };
    },
  };

  return [createIssue, commentIssue, mergePr];
}

/** Factory that builds a real HTTP client from the secret store (provider "github"). */
export function httpGithubClientFactory(): GithubClientFactory {
  return async (ctx: ToolContext) => {
    const token = await ctx.secrets.get("secret/github");
    if (!token) throw new Error("no github token configured (secret/github)");
    return new HttpGithubClient(token);
  };
}
