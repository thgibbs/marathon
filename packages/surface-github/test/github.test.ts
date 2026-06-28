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

  it("detects a merged pull_request (approve-by-merge)", () => {
    const a = classifyGithubEvent("pull_request", {
      action: "closed",
      repository: { full_name: "o/repo" },
      pull_request: { number: 7, merged: true, merge_commit_sha: "abc123" },
    });
    expect(a).toMatchObject({ kind: "merge", repo: "o/repo", number: 7, mergeCommitSha: "abc123" });
  });

  it("ignores non-mentions, non-merged closes, and other events", () => {
    expect(classifyGithubEvent("issue_comment", { action: "created", comment: { body: "no mention here" } }).kind).toBe("ignore");
    expect(classifyGithubEvent("pull_request", { action: "closed", pull_request: { merged: false } }).kind).toBe("ignore");
    expect(classifyGithubEvent("push", {}).kind).toBe("ignore");
  });
});
