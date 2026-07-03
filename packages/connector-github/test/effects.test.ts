import type { SecretStore } from "@marathon/config";
import type { ProposedEffect } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { GITHUB_MERGE_EFFECT, makeGithubMergeExecutor } from "../src/effects";

const secrets: SecretStore = { get: async () => "tok" };

function effectWith(target: Record<string, unknown>): ProposedEffect {
  const now = new Date();
  return {
    id: "pe-1",
    tenantId: "tenant-1",
    taskId: "task-1",
    connectorId: null,
    effectType: GITHUB_MERGE_EFFECT,
    target,
    payload: target,
    payloadHash: "h",
    proposalVersion: 1,
    provenance: null,
    riskAxes: null,
    rollbackPlan: null,
    reviewerId: null,
    reviewerAuthority: null,
    approvalExpiresAt: null,
    idempotencyKey: "k",
    executionState: "executing",
    createdAt: now,
    resolvedAt: now,
    executedAt: null,
  };
}

describe("makeGithubMergeExecutor (Track 9)", () => {
  it("merges the exact approved PR with brokered credentials", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    const res = await exec(effectWith({ repo: "acme/service", number: 12 }), { secrets });
    expect(res.summary).toContain("merged acme/service#12");
    expect(client.writes).toEqual([{ op: "mergePullRequest", args: { repo: "acme/service", prNumber: 12 } }]);
  });

  it("refuses repos outside the allowlist and malformed targets", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    await expect(exec(effectWith({ repo: "evil/repo", number: 1 }), { secrets })).rejects.toThrow(/repo not allowed/);
    await expect(exec(effectWith({ repo: "acme/service" }), { secrets })).rejects.toThrow(/target.number/);
    expect(client.writes).toHaveLength(0);
  });
});
