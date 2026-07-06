import type { Task } from "@marathon/core";
import { describe, expect, it, vi } from "vitest";
import {
  defaultAudienceTrust,
  makeRepoChatWorkspaceProvider,
  mayGround,
  type ChatWorkspaceProviderDeps,
  type ResolvedChatWorkspace,
} from "../src/chat-workspace-provider";

const REPO = "acme/widgets";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    tenantId: "tn1",
    agentId: "a1",
    agentVersionId: null,
    invokingUserId: "u1",
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.1" }, // a normal channel → unknown trust
    deliveryTargets: null,
    status: "running",
    inputText: "what does the limiter do?",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function fakeResolved(sha: string): ResolvedChatWorkspace {
  return { workspace: { dir: `/tmp/ws-${sha}`, baseSha: sha }, sha, dispose: async () => {} };
}

function makeDeps(overrides: Partial<ChatWorkspaceProviderDeps> = {}): {
  deps: ChatWorkspaceProviderDeps;
  materialize: ReturnType<typeof vi.fn>;
  denied: Array<{ reason: string }>;
} {
  const materialize = vi.fn(async (_source: string, ref?: string) => fakeResolved(ref ?? "head-sha"));
  const denied: Array<{ reason: string }> = [];
  const deps: ChatWorkspaceProviderDeps = {
    repo: REPO,
    enabled: true,
    groundRef: "pinned",
    source: async (r) => `https://x-access-token:tok@github.com/${r}.git`,
    checkAccess: async () => "ok",
    repoVisibility: async () => "public",
    materialize,
    onDenied: (_t, reason) => void denied.push({ reason }),
    ...overrides,
  };
  return { deps, materialize, denied };
}

describe("mayGround (§3.1 visibility × trust)", () => {
  it("public grounds for any audience; private only for internal_confirmed", () => {
    expect(mayGround("public", "unknown")).toBe(true);
    expect(mayGround("public", "external")).toBe(true);
    expect(mayGround("private", "internal_confirmed")).toBe(true);
    expect(mayGround("private", "unknown")).toBe(false); // the P1 fix — no silent pass
    expect(mayGround("private", "external")).toBe(false);
  });
});

describe("defaultAudienceTrust (§3.1)", () => {
  it("maps a DM to internal_confirmed and a plain channel to unknown", () => {
    expect(defaultAudienceTrust(task({ sourceRef: { channel: "D999" } }))).toBe("internal_confirmed");
    expect(defaultAudienceTrust(task({ sourceRef: { channel: "C1", thread_ts: "1.1" } }))).toBe("unknown");
  });

  it("maps a GitHub repo-scoped task to internal_confirmed", () => {
    expect(defaultAudienceTrust(task({ sourceType: "github", sourceRef: { repo: REPO, number: 5 } }))).toBe(
      "internal_confirmed",
    );
  });
});

describe("makeRepoChatWorkspaceProvider gate (§3.1)", () => {
  it("grounds a public repo in an unknown-audience channel and materializes it", async () => {
    const { deps, materialize } = makeDeps();
    const resolved = await makeRepoChatWorkspaceProvider(deps)(task());
    expect(resolved?.sha).toBe("head-sha");
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("does NOT ground a private repo in an unknown-audience channel (P1 deny-by-default)", async () => {
    const { deps, materialize } = makeDeps({ repoVisibility: async () => "private" });
    expect(await makeRepoChatWorkspaceProvider(deps)(task())).toBeUndefined();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("grounds a private repo when the audience is internal_confirmed (a DM)", async () => {
    const { deps, materialize } = makeDeps({ repoVisibility: async () => "private" });
    const resolved = await makeRepoChatWorkspaceProvider(deps)(task({ sourceRef: { channel: "D1" } }));
    expect(resolved).toBeDefined();
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("skips when there is no repo, when disabled, or when there is no invoking user", async () => {
    expect(await makeRepoChatWorkspaceProvider(makeDeps({ repo: undefined }).deps)(task())).toBeUndefined();
    expect(await makeRepoChatWorkspaceProvider(makeDeps({ enabled: false }).deps)(task())).toBeUndefined();
    expect(await makeRepoChatWorkspaceProvider(makeDeps().deps)(task({ invokingUserId: null }))).toBeUndefined();
  });

  it("denies (no workspace) and surfaces the CTA for each access failure", async () => {
    for (const reason of ["no_link", "stale", "no_access"] as const) {
      const { deps, materialize, denied } = makeDeps({ checkAccess: async () => reason });
      expect(await makeRepoChatWorkspaceProvider(deps)(task())).toBeUndefined();
      expect(materialize).not.toHaveBeenCalled();
      expect(denied).toEqual([{ reason }]);
    }
  });

  it("emits a denial note at most once per (task, reason) via claimOnce (P2)", async () => {
    const claimed = new Set<string>();
    const { deps, denied } = makeDeps({
      checkAccess: async () => "no_link",
      claimOnce: async (key) => (claimed.has(key) ? false : (claimed.add(key), true)),
    });
    const provider = makeRepoChatWorkspaceProvider(deps);
    await provider(task());
    await provider(task()); // retry/resume of the SAME task
    await provider(task());
    expect(denied).toHaveLength(1);
  });
});

describe("makeRepoChatWorkspaceProvider sha pinning (§3.3)", () => {
  it("pinned mode materializes the recorded sha on resume", async () => {
    const { deps, materialize } = makeDeps({ groundRef: "pinned" });
    await makeRepoChatWorkspaceProvider(deps)(task(), { pinnedSha: "cafe1234" });
    expect(materialize).toHaveBeenCalledWith(expect.stringContaining(REPO), "cafe1234");
  });

  it("latest mode ignores the recorded sha (re-resolves HEAD)", async () => {
    const { deps, materialize } = makeDeps({ groundRef: "latest" });
    await makeRepoChatWorkspaceProvider(deps)(task(), { pinnedSha: "cafe1234" });
    expect(materialize).toHaveBeenCalledWith(expect.stringContaining(REPO), undefined);
  });
});
