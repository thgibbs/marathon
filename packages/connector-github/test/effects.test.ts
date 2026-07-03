import type { SecretStore } from "@marathon/config";
import type { ProposedEffect } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { FixturesGithubClient } from "../src/client";
import { GITHUB_MERGE_EFFECT, makeGithubMergeExecutor } from "../src/effects";

const secrets: SecretStore = { get: async () => "tok" };

function effectWith(target: Record<string, unknown>, payload: Record<string, unknown> = target): ProposedEffect {
  const now = new Date();
  return {
    id: "pe-1",
    tenantId: "tenant-1",
    taskId: "task-1",
    connectorId: null,
    effectType: GITHUB_MERGE_EFFECT,
    target,
    payload,
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

  it("executes FROM the approved payload — the merge method the reviewer saw is what runs", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    const target = { repo: "acme/service", number: 12 };
    const res = await exec(effectWith(target, { ...target, method: "squash" }), { secrets });
    expect(client.writes).toEqual([
      { op: "mergePullRequest", args: { repo: "acme/service", prNumber: 12, method: "squash" } },
    ]);
    expect(res.details).toMatchObject({ method: "squash" });
  });

  it("refuses payload fields it does not understand (reviewed artifact == executed artifact)", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    const target = { repo: "acme/service", number: 12 };
    await expect(exec(effectWith(target, { ...target, delete_branch: true }), { secrets })).rejects.toThrow(
      /unsupported payload field/,
    );
    await expect(exec(effectWith(target, { ...target, method: "fast-forward" }), { secrets })).rejects.toThrow(
      /payload.method/,
    );
    expect(client.writes).toHaveLength(0);
  });

  it("refuses a proposal whose target and payload disagree", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    await expect(
      exec(effectWith({ repo: "acme/service", number: 12 }, { repo: "acme/service", number: 13 }), { secrets }),
    ).rejects.toThrow(/target does not match its payload/);
    expect(client.writes).toHaveLength(0);
  });

  it("refuses repos outside the allowlist and malformed payloads", async () => {
    const client = new FixturesGithubClient({});
    const exec = makeGithubMergeExecutor(() => client, { allowedRepos: ["acme/service"] });
    await expect(exec(effectWith({ repo: "evil/repo", number: 1 }), { secrets })).rejects.toThrow(/repo not allowed/);
    await expect(exec(effectWith({ repo: "acme/service" }), { secrets })).rejects.toThrow(/payload.number/);
    await expect(exec(effectWith({ number: 1 }), { secrets })).rejects.toThrow(/payload.repo/);
    expect(client.writes).toHaveLength(0);
  });
});
