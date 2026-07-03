import type { StructuredResult } from "./types";

/** Render a structured result to markdown-ish text (design.md §15.5). */
export function renderResultText(result: StructuredResult): string {
  const lines: string[] = [result.summary];
  if (result.recommendation) lines.push(`\n*Recommendation:* ${result.recommendation}`);
  if (result.evidence?.length) {
    lines.push(`\n*Evidence:*\n${result.evidence.map((e) => `• ${e}`).join("\n")}`);
  }
  if (result.actionsTaken?.length) {
    lines.push(`\n*Actions taken:*\n${result.actionsTaken.map((a) => `• ${a}`).join("\n")}`);
  }
  if (result.openQuestions?.length) {
    lines.push(`\n*Open questions:*\n${result.openQuestions.map((q) => `• ${q}`).join("\n")}`);
  }
  if (result.crossLinks?.length) {
    lines.push(`\n_also delivered to: ${result.crossLinks.join(", ")}_`);
  }
  if (typeof result.costUsd === "number") {
    lines.push(`\n_cost: $${result.costUsd.toFixed(4)}_`);
  }
  return lines.join("\n");
}
