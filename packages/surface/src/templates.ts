/**
 * Versioned markdown document templates (design §7.17). An agent's body content is
 * rendered into a known document shape (postmortem / PRD / release notes), or passed
 * through unchanged for `generic`. The template version is part of `prompt_version`
 * (§7.18) for reproducibility.
 */
export type DocTemplate = "generic" | "postmortem" | "prd" | "release_notes";

export const DOC_TEMPLATE_VERSION = "1";

export function isDocTemplate(v: unknown): v is DocTemplate {
  return v === "generic" || v === "postmortem" || v === "prd" || v === "release_notes";
}

const SCAFFOLDS: Record<Exclude<DocTemplate, "generic">, string[]> = {
  postmortem: ["## Summary", "## Impact", "## Timeline", "## Root cause", "## Resolution", "## Action items"],
  prd: ["## Problem", "## Goals", "## Non-goals", "## Proposal", "## Risks", "## Open questions"],
  release_notes: ["## Highlights", "## Changes", "## Upgrade notes", "## Known issues"],
};

/**
 * Render a document. For `generic`, returns the body under a title. For a known
 * template, places the body under the first section and stubs the remaining
 * sections so the structure is explicit for review.
 */
export function renderDocument(template: DocTemplate, title: string, body: string): string {
  const header = `# ${title}\n`;
  if (template === "generic") {
    return `${header}\n${body.trim()}\n`;
  }
  const sections = SCAFFOLDS[template];
  const parts = sections.map((heading, i) =>
    i === 0 ? `${heading}\n\n${body.trim()}` : `${heading}\n\n_TODO_`,
  );
  return `${header}\n${parts.join("\n\n")}\n`;
}
