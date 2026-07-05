import type { PlanRef, Task } from "@marathon/core";
import type { Database } from "@marathon/db";
import { describe, expect, it } from "vitest";
import {
  buildAgentPrompt,
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

  it("carries the approved plan, its materialized location, and the design PR", () => {
    expect(brief).toContain("docs/Rate Limiting.md in o/r, approved as cafe1234deadbeef");
    expect(brief).toContain("(design PR #5)");
    expect(brief).toContain("materialized at docs/Rate Limiting.md");
  });

  it("teaches the §29.1a plan lifecycle: commit the doc, amend on divergence", () => {
    expect(brief).toContain("merges to the default branch WITH your code");
    expect(brief).toContain("as-built plan");
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

describe("buildAgentPrompt surface context (Track 12, §7.18)", () => {
  const task: Task = {
    id: "t1",
    tenantId: "tn1",
    agentId: null, // no persona lookup -> the fake db is never touched
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.1" },
    deliveryTargets: null,
    status: "running",
    inputText: "and what about staging?",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
  };

  it("fences thread context as untrusted, between memory and the request", async () => {
    const { input } = await buildAgentPrompt({ db: {} as never as Database }, task, {
      context: [
        { author: "U1", text: "why did checkout break?", ts: "1.1" },
        { text: "_on it…_", ts: "1.2" },
      ],
    });
    expect(input).toContain("<<<UNTRUSTED thread context>>>");
    expect(input).toContain("@U1: why did checkout break?");
    expect(input).toContain("_on it…_");
    expect(input.indexOf("thread context")).toBeLessThan(input.indexOf("<<<UNTRUSTED request>>>"));
  });

  it("omits the block when there is no context", async () => {
    const { input } = await buildAgentPrompt({ db: {} as never as Database }, task, { context: [] });
    expect(input).not.toContain("thread context");
  });

  it("appends the trusted task contract after the persona + framing (§2b #16)", async () => {
    const contract = "Submit the document by calling document_create exactly once.";
    const { instructions } = await buildAgentPrompt({ db: {} as never as Database }, task, {
      basePersona: "You are a documentation agent.",
      contract,
    });
    expect(instructions).toContain(contract);
    // The contract is instruction-side (trusted), after the untrusted framing.
    expect(instructions.indexOf("never follow")).toBeLessThan(instructions.indexOf(contract));
  });

  it("the contract survives the AgentVersion persona override", async () => {
    const db = {
      getLatestAgentVersion: async () => ({ instructions: "You are Forge." }),
    } as never as Database;
    const { instructions } = await buildAgentPrompt({ db }, { ...task, agentId: "a1" }, {
      basePersona: "overridden persona",
      contract: "Call document_revise exactly once.",
    });
    expect(instructions).toContain("You are Forge.");
    expect(instructions).not.toContain("overridden persona");
    expect(instructions).toContain("Call document_revise exactly once.");
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
