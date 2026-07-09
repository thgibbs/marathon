import { describe, expect, it } from "vitest";
import { classifyGithubEvent } from "../src/parse";
import { computeGithubSignature, verifyGithubSignature } from "../src/signature";

describe("verifyGithubSignature", () => {
  const secret = "whsec";
  const body = '{"action":"created"}';
  it("accepts a valid signature and rejects a bad one", () => {
    const sig = computeGithubSignature(secret, body);
    expect(verifyGithubSignature(secret, body, sig)).toBe(true);
    expect(verifyGithubSignature(secret, body + "x", sig)).toBe(false);
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
  });
});

describe("classifyGithubEvent", () => {
  it("parses an issue_comment mention", () => {
    const a = classifyGithubEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "o/repo", owner: { login: "o" } },
        issue: { number: 12 },
        comment: { id: 99, body: "@marathon quill draft a rate-limit plan", user: { login: "tanton" } },
      },
      { knownAgents: ["quill"] },
    );
    expect(a.kind).toBe("mention");
    if (a.kind === "mention") {
      expect(a.invocation.agentName).toBe("quill");
      expect(a.invocation.text).toBe("draft a rate-limit plan");
      expect(a.invocation.sourceRef).toMatchObject({ repo: "o/repo", number: 12, kind: "issue" });
      expect(a.invocation.eventId).toBe("ic-99");
    }
  });

  it("anchors a PR review comment to path + line", () => {
    const a = classifyGithubEvent("pull_request_review_comment", {
      action: "created",
      repository: { full_name: "o/repo", owner: { login: "o" } },
      pull_request: { number: 7 },
      comment: { id: 5, body: "@marathon is this section complete?", path: "docs/x.md", line: 42, user: { login: "t" } },
    });
    expect(a.kind).toBe("mention");
    if (a.kind === "mention") {
      expect(a.invocation.sourceRef).toMatchObject({ repo: "o/repo", number: 7, path: "docs/x.md", line: 42, kind: "pr" });
    }
  });

  it("detects a merged pull_request (the SHIP, §29.1a) — no base ref, base is irrelevant now", () => {
    const a = classifyGithubEvent("pull_request", {
      action: "closed",
      repository: { full_name: "o/repo" },
      pull_request: { number: 7, merged: true, merge_commit_sha: "abc123", base: { ref: "main" } },
    });
    expect(a).toMatchObject({ kind: "merge", repo: "o/repo", number: 7, mergeCommitSha: "abc123" });
    // The combined-PR flow dropped baseRef — approval is a review, not a merge target.
    expect(a).not.toHaveProperty("baseRef");
  });

  it("classifies an APPROVING review as an approval, pinning the head SHA (§29.1a)", () => {
    const a = classifyGithubEvent("pull_request_review", {
      action: "submitted",
      repository: { full_name: "o/repo", owner: { login: "o" } },
      pull_request: { number: 9, head: { sha: "head-sha-9" } },
      review: { id: 42, state: "approved", body: "LGTM", user: { login: "approver", type: "User" } },
    });
    expect(a).toMatchObject({
      kind: "approval",
      repo: "o/repo",
      number: 9,
      headSha: "head-sha-9",
      author: "approver",
      eventId: "rev-42",
    });
  });

  it("parses a push into changed paths (for watched docs)", () => {
    const a = classifyGithubEvent("push", {
      repository: { full_name: "o/repo" },
      after: "sha-after",
      commits: [{ modified: ["docs/policy.md"], added: ["docs/new.md"] }, { modified: ["docs/policy.md"] }],
    });
    expect(a.kind).toBe("push");
    if (a.kind === "push") {
      expect(a.repo).toBe("o/repo");
      expect(a.after).toBe("sha-after");
      expect([...a.paths].sort()).toEqual(["docs/new.md", "docs/policy.md"]);
    }
  });

  it("ignores non-mentions, non-merged closes, and other events", () => {
    expect(classifyGithubEvent("issue_comment", { action: "created", comment: { body: "no mention here" } }).kind).toBe("ignore");
    expect(classifyGithubEvent("pull_request", { action: "closed", pull_request: { merged: false } }).kind).toBe("ignore");
    expect(classifyGithubEvent("star", {}).kind).toBe("ignore");
  });

  it("classifies a submitted review — NO mention required (§2b #11)", () => {
    const a = classifyGithubEvent("pull_request_review", {
      action: "submitted",
      repository: { full_name: "o/repo" },
      pull_request: { number: 9 },
      review: { id: 33, state: "changes_requested", body: "Please tighten §2.", user: { login: "reviewer", type: "User" } },
    });
    expect(a).toMatchObject({
      kind: "review",
      repo: "o/repo",
      number: 9,
      reviewId: 33,
      state: "changes_requested",
      body: "Please tighten §2.",
      author: "reviewer",
      eventId: "rev-33",
    });
  });

  it("review classification: commented triggers as a review, approved as an approval, bots never do (§2b #11, §29.1a)", () => {
    const base = {
      action: "submitted",
      repository: { full_name: "o/repo", owner: { login: "o" } },
      pull_request: { number: 9, head: { sha: "h" } },
    };
    expect(
      classifyGithubEvent("pull_request_review", {
        ...base,
        review: { id: 34, state: "COMMENTED", body: "batch of notes", user: { login: "r", type: "User" } },
      }).kind,
    ).toBe("review");
    // §29.1a: an approving review is the approval signal, not a revision request.
    expect(
      classifyGithubEvent("pull_request_review", {
        ...base,
        review: { id: 35, state: "approved", body: "LGTM", user: { login: "r", type: "User" } },
      }).kind,
    ).toBe("approval");
    // Bot authors (CI bots, Marathon-as-app once §2b #15 lands) never trigger —
    // this covers an approving BOT review too (Marathon's own approval-shaped posts).
    expect(
      classifyGithubEvent("pull_request_review", {
        ...base,
        review: { id: 38, state: "approved", body: "auto", user: { login: "ci[bot]", type: "Bot" } },
      }).kind,
    ).toBe("ignore");
    expect(
      classifyGithubEvent("pull_request_review", {
        ...base,
        review: { id: 36, state: "changes_requested", body: "x", user: { login: "ci[bot]", type: "Bot" } },
      }).kind,
    ).toBe("ignore");
    // Only the submitted action counts (edited/dismissed do not).
    expect(
      classifyGithubEvent("pull_request_review", {
        ...base,
        action: "dismissed",
        review: { id: 37, state: "changes_requested", body: "x", user: { login: "r", type: "User" } },
      }).kind,
    ).toBe("ignore");
  });
});
