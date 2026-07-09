import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { makeReviewReportTool, MAX_AUTO_REVIEW_ROUNDS, REVIEW_COMMENT_MARKER, renderReviewComment, shouldKickBack } from "../src/review-tools";

const ctx = { taskId: "t1", tenantId: "tn1", secrets: new EnvSecretStore({}) };

describe("review.report (§A.3a — comment-only reviewer verdict)", () => {
  it("posts the summary as a PR comment (marker + verdict label + body) and records the verdict", async () => {
    const gh = new FixturesGithubClient({});
    const recorded: Array<Record<string, unknown>> = [];
    const tool = makeReviewReportTool({ getClient: () => gh, onReviewed: (i) => void recorded.push(i) });

    const res = await tool.execute(
      { repo: "o/r", number: 12, verdict: "changes_requested", summary: "Missing tests for the retry path." },
      ctx,
    );

    const comment = gh.writes.find((w) => w.op === "commentIssue")!.args as { repo: string; issueNumber: number; body: string };
    expect(comment.repo).toBe("o/r");
    expect(comment.issueNumber).toBe(12);
    expect(comment.body).toContain(REVIEW_COMMENT_MARKER);
    expect(comment.body).toContain("CHANGES REQUESTED");
    expect(comment.body).toContain("Missing tests for the retry path.");

    // The structured verdict is recorded for the kickback loop (Phase 3).
    expect(recorded).toEqual([
      { taskId: "t1", repo: "o/r", prNumber: 12, verdict: "changes_requested", summary: "Missing tests for the retry path." },
    ]);
    expect((res.details as { verdict: string }).verdict).toBe("changes_requested");
  });

  it("renders an APPROVED comment for an approving verdict", () => {
    expect(renderReviewComment("approved", "LGTM")).toContain("APPROVED");
    expect(renderReviewComment("approved", "LGTM")).toContain(REVIEW_COMMENT_MARKER);
  });

  it("rejects a bad verdict and a missing summary in validate()", () => {
    const tool = makeReviewReportTool({ getClient: () => new FixturesGithubClient({}) });
    expect(tool.validate!({ repo: "o/r", number: 1, verdict: "lgtm", summary: "x" })).toMatch(/verdict/);
    expect(tool.validate!({ repo: "o/r", number: 1, verdict: "approved", summary: "  " })).toMatch(/summary/);
    expect(tool.validate!({ repo: "o/r", verdict: "approved", summary: "x" })).toMatch(/number/);
    expect(tool.validate!({ repo: "o/r", number: 1, verdict: "approved", summary: "ok" })).toBeNull();
  });

  it("shouldKickBack: only changes_requested, only under the cap; approved never bounces (§A.3a)", () => {
    expect(MAX_AUTO_REVIEW_ROUNDS).toBe(2);
    // changes_requested under/at the cap bounces back to the owner to revise.
    expect(shouldKickBack("changes_requested", 1)).toBe(true);
    expect(shouldKickBack("changes_requested", 2)).toBe(true);
    // ...but the round past the cap stops and waits for a human.
    expect(shouldKickBack("changes_requested", 3)).toBe(false);
    // approved never kicks back (and never merges — a human owns that).
    expect(shouldKickBack("approved", 1)).toBe(false);
  });

  it("is best-effort: a recording-hook failure does not fail the already-posted review", async () => {
    const gh = new FixturesGithubClient({});
    const tool = makeReviewReportTool({
      getClient: () => gh,
      onReviewed: () => {
        throw new Error("db down");
      },
    });
    await expect(
      tool.execute({ repo: "o/r", number: 3, verdict: "approved", summary: "ship it" }, ctx),
    ).resolves.toMatchObject({ details: { verdict: "approved" } });
    expect(gh.writes.some((w) => w.op === "commentIssue")).toBe(true);
  });
});
