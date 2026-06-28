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

/** Factory that builds a real HTTP client from the secret store (provider "github"). */
export function httpGithubClientFactory(): GithubClientFactory {
  return async (ctx: ToolContext) => {
    const token = await ctx.secrets.get("secret/github");
    if (!token) throw new Error("no github token configured (secret/github)");
    return new HttpGithubClient(token);
  };
}
