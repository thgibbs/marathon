/**
 * Model-facing definitions for the governed GitHub/document tools (M6.1).
 * These are the schemas a harness (Pi custom tools, later MCP for Claude
 * Code — §7.5) shows the model; execution always goes through the Tool
 * Gateway, which re-validates against the real `Tool.validate`. Kept next to
 * the tools they describe so the two stay in sync.
 *
 * The list an app actually exposes is `spec.tools ∩ this catalog` — the YAML
 * grants drive the surface, and a granted tool a surface cannot serve (e.g.
 * the BUILD broker) is simply absent from its catalog slice.
 */
export interface GovernedToolDef {
  name: string;
  description: string;
  /** JSON-schema-ish parameters shown to the model. */
  parameters: Record<string, unknown>;
}

const repoProp = { repo: { type: "string", description: 'Repository as "owner/name".' } };

export const GOVERNED_TOOL_DEFS: Record<string, GovernedToolDef> = {
  "github.read_file": {
    name: "github.read_file",
    description: "Read a file from a GitHub repository.",
    parameters: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo", "path"] },
  },
  "github.list_contents": {
    name: "github.list_contents",
    description: "List files/directories at a path in a GitHub repository.",
    parameters: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo"] },
  },
  "document.read_region": {
    name: "document.read_region",
    description: "Read a markdown file (optionally a line range) from the repo.",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, ref: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } },
      required: ["repo", "path"],
    },
  },
  "document.create": {
    name: "document.create",
    description: "Create a markdown design document by opening a pull request (a human merging it is the approval).",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, title: { type: "string" }, base: { type: "string" } },
      required: ["repo", "path", "content"],
    },
  },
  "document.update": {
    name: "document.update",
    description: "Update a markdown document via a pull request (pass the file's current git sha).",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, sha: { type: "string" }, base: { type: "string" } },
      required: ["repo", "path", "content", "sha"],
    },
  },
  "document.revise": {
    name: "document.revise",
    description: "Revise an existing document by committing to its open PR branch.",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, branch: { type: "string" } },
      required: ["repo", "path", "content", "branch"],
    },
  },
  "review.report": {
    name: "review.report",
    description:
      "Report your review of a pull request: post a summary comment and record your verdict. " +
      "Does not approve, request changes as a formal GitHub review, merge, or trigger a build.",
    parameters: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "The pull-request number under review." },
        verdict: { type: "string", enum: ["approved", "changes_requested"], description: "Your overall verdict." },
        summary: { type: "string", description: "Concise, human-readable review findings (posted as the PR comment)." },
      },
      required: ["repo", "number", "verdict", "summary"],
    },
  },
};

/** The catalog slice for a spec's tool grants (order follows the grants). */
export function governedToolDefsFor(toolNames: string[]): GovernedToolDef[] {
  return toolNames
    .map((t) => GOVERNED_TOOL_DEFS[t])
    .filter((d): d is GovernedToolDef => d !== undefined);
}
