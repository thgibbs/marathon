import type { Tool, ToolContext } from "@marathon/tools";
import { HttpGithubClient, type GithubClient } from "./client";

export type GithubClientFactory = (ctx: ToolContext) => GithubClient | Promise<GithubClient>;

/** Read-only GitHub tools, parameterized over a client (real or fixtures). */
export function makeGithubReadTools(getClient: GithubClientFactory): Tool[] {
  const readFile: Tool = {
    name: "github.read_file",
    description: "Read a file from a GitHub repository.",
    riskLevel: "low",
    destructive: false,
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
    riskLevel: "low",
    destructive: false,
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

/** GitHub write tools. Create/comment are non-destructive (autonomous); merge is destructive (approval). */
export function makeGithubWriteTools(getClient: GithubClientFactory): Tool[] {
  const createIssue: Tool = {
    name: "github.create_issue",
    description: "Create an issue in a GitHub repository.",
    riskLevel: "medium",
    destructive: false,
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
    riskLevel: "low",
    destructive: false,
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
    description: "Merge a pull request (destructive).",
    riskLevel: "high",
    destructive: true,
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
