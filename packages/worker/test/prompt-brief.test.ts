import type { PlanRef } from "@marathon/core";
import { describe, expect, it } from "vitest";
import {
  renderImplementationBrief,
  renderRevisionBrief,
  suggestedImplementationBranch,
} from "../src/prompt";

const PLAN: PlanRef = { repo: "o/r", docPath: "docs/Rate Limiting.md", mergeCommitSha: "cafe1234deadbeef" };

describe("suggestedImplementationBranch (Track 10)", () => {
  it("is deterministic per merged plan version", () => {
    expect(suggestedImplementationBranch(PLAN)).toBe("marathon/docs-rate-limiting-cafe123");
    expect(suggestedImplementationBranch(PLAN)).toBe(suggestedImplementationBranch(PLAN));
  });

  it("changes when the plan is re-merged (new sha ⇒ new suggested branch)", () => {
    expect(suggestedImplementationBranch({ ...PLAN, mergeCommitSha: "0123456789ab" })).toBe(
      "marathon/docs-rate-limiting-0123456",
    );
  });

  it("falls back to a safe slug for degenerate paths", () => {
    expect(suggestedImplementationBranch({ ...PLAN, docPath: "…" })).toBe("marathon/impl-cafe123");
  });
});

describe("renderImplementationBrief (Track 10)", () => {
  const brief = renderImplementationBrief({
    planRef: PLAN,
    docPrNumber: 5,
    deliveryTargets: [
      { surfaceType: "slack", ref: { channel: "C1", thread_ts: "1.1" } },
      { surfaceType: "github", ref: { repo: "o/r", number: 5, kind: "pr" } },
    ],
  });

  it("carries the merged plan, pinned base, and design PR", () => {
    expect(brief).toContain("docs/Rate Limiting.md in o/r, merged as cafe1234deadbeef");
    expect(brief).toContain("(design PR #5)");
    expect(brief).toContain("base_sha");
  });

  it("suggests (but does not mandate) the branch", () => {
    expect(brief).toContain("Suggested branch: marathon/docs-rate-limiting-cafe123");
    expect(brief).toContain("yours to change");
  });

  it("teaches the brokered git/gh + delivery.report_pr contract", () => {
    expect(brief).toContain('git.exec { argv: ["push"');
    expect(brief).toContain("github.exec");
    expect(brief).toContain("delivery.report_pr EXACTLY ONCE");
    expect(brief).toContain("NO credentials");
  });

  it("lists every delivery target", () => {
    expect(brief).toContain("Slack channel C1");
    expect(brief).toContain("https://github.com/o/r/pull/5");
  });

  it("omits the target section when there are none", () => {
    const bare = renderImplementationBrief({ planRef: PLAN });
    expect(bare).not.toContain("delivered to:");
  });
});

describe("renderRevisionBrief (Track 10, §29.6)", () => {
  const brief = renderRevisionBrief({
    repo: "o/r",
    prNumber: 9,
    prUrl: "https://github.com/o/r/pull/9",
    branch: "marathon/impl-x",
    planRef: PLAN,
    comment: "handle empty names too",
    commentAuthor: "alice",
  });

  it("pins the revision to the branch and PR, with the plan for context", () => {
    expect(brief).toContain("https://github.com/o/r/pull/9");
    expect(brief).toContain("branch marathon/impl-x");
    expect(brief).toContain("docs/Rate Limiting.md @ cafe1234deadbeef");
  });

  it("fences the reviewer's comment as untrusted", () => {
    expect(brief).toContain("handle empty names too");
    expect(brief).toMatch(/<<<UNTRUSTED[^>]*review comment/);
  });

  it("teaches the same-branch update + re-report contract", () => {
    expect(brief).toContain('git.exec { argv: ["push", "o/r", "HEAD:refs/heads/marathon/impl-x"] }');
    expect(brief).toContain("PR #9 updates in place");
    expect(brief).toContain("delivery.report_pr EXACTLY ONCE");
  });
});
