import type { AgentWorkspaceBinding } from "@marathon/agent";
import type { Task } from "@marathon/core";
import { audienceForTask } from "@marathon/memory";

/**
 * Chat-surface repo grounding — the provider (chat-repo.md §3.1/§3.2).
 *
 * A per-task policy that decides whether a chat task gets a **read-only**
 * checkout of its agent's repo, and materializes it. Deny-by-default: it
 * grounds only when every condition is *positively* satisfied. It lives in
 * `@marathon/worker` (which already depends on `@marathon/memory` for the
 * audience derivation); the access check and repo-visibility lookup are
 * injected from the live app so the package graph stays acyclic.
 */

/** The result the step runner threads into the turn and tears down after (§3.2). */
export interface ResolvedChatWorkspace {
  workspace: AgentWorkspaceBinding;
  /** The exact commit the checkout is at — pinned + recorded as a source (§7.8). */
  sha: string;
  /** Always called in the step runner's finally — removes the checkout (§3.3). */
  dispose(): Promise<void>;
}

/** The invoking user's live access to the repo, asked as them (§2b #10). */
export type RepoAccessResult = "ok" | "no_access" | "no_link" | "stale";

/** Who can see the task's output — collapsed to three trust levels (§3.1). */
export type AudienceTrust = "internal_confirmed" | "external" | "unknown";

export interface ChatWorkspaceProviderDeps {
  /** The agent's ONE configured repo (`spec.repo`). No repo → no grounding. */
  repo?: string;
  /** `spec.chat.groundOnRepo` — the opt-in. */
  enabled: boolean;
  /** `spec.chat.groundRef` — pin the first resolved sha vs. re-resolve HEAD. */
  groundRef: "pinned" | "latest";
  /** Brokered, host-side clone URL for the repo (credential stays host-side). */
  source: (repo: string) => string | Promise<string>;
  /** Live per-user access check (built from `makeUserRepoAccessChecker`). */
  checkAccess: (tenantId: string, userId: string, repo: string) => Promise<RepoAccessResult>;
  /** Repo visibility for the audience×visibility rule (built from the GithubClient). */
  repoVisibility: (repo: string) => Promise<"public" | "private">;
  /**
   * Audience trust for a task. Defaults to {@link defaultAudienceTrust} (DMs →
   * internal_confirmed; everything else "unknown" until Slack external flags
   * land). Injectable so a deployment with an admin channel↔internal map can
   * promote channels.
   */
  audienceTrust?: (task: Task) => AudienceTrust;
  /** Shallow read-only clone at `ref` (or HEAD); returns the binding + sha + dispose. */
  materialize: (source: string, ref?: string) => Promise<ResolvedChatWorkspace>;
  /**
   * Burn-once dedupe for denial notices (chat-repo.md §7): returns true the
   * FIRST time a `(task, reason)` is seen. Wire to `db.claim`. When omitted,
   * `onDenied` fires every call (fine for tests).
   */
  claimOnce?: (key: string) => Promise<boolean>;
  /** Surfaced (at most once per task+reason) when access is denied — the link CTA. */
  onDenied?: (task: Task, reason: "no_link" | "stale" | "no_access") => void | Promise<void>;
  /**
   * Called when materialization succeeds — the checkout is a **source**
   * (chat-repo.md §3.3, §7.8), so the caller records `github:${repo}` at `sha`
   * in the task's SourceLedger before any later egress decision.
   */
  onGrounded?: (task: Task, grounded: { repo: string; sha: string; visibility: "public" | "private" }) => void | Promise<void>;
  /**
   * Called when a non-policy I/O step fails (visibility lookup, clone source,
   * materialization). Grounding is best-effort — the failure is logged/audited
   * here and the task continues **ungrounded** (chat-repo.md §7). Distinct from
   * an access/audience *decline*, which is a policy decision, not an error.
   */
  onError?: (task: Task, err: unknown) => void | Promise<void>;
}

/**
 * Derive the audience trust from `audienceForTask` (§3.1). A positively-internal
 * audience (a Slack DM → user level, or a GitHub repo-scoped task) is
 * `internal_confirmed`; an `external` audience is `external`; **everything else
 * is `unknown`** — never a silent pass, so `undefined !== true` can't sneak a
 * private repo through.
 */
export function defaultAudienceTrust(task: Task): AudienceTrust {
  const audience = audienceForTask(task);
  if (audience.external) return "external";
  // GitHub: the task is anchored to a repo whose audience is native + trusted.
  if (task.sourceType === "github") return "internal_confirmed";
  // Slack DM: exactly one known person (user-level audience).
  if (task.sourceType === "slack" && audience.level === "user") return "internal_confirmed";
  // A Slack CHANNEL resolves to a project-level pseudo-audience, but its
  // membership is unverified until external-member flags land (§3.6) — so it is
  // "unknown", NOT internal_confirmed. Everything else is conservative too.
  return "unknown";
}

/** Should a repo of this visibility ground for this audience trust? (§3.1 table.) */
export function mayGround(visibility: "public" | "private", trust: AudienceTrust): boolean {
  if (visibility === "public") return true; // audience is moot — already public
  return trust === "internal_confirmed"; // private: only a confirmed-internal audience
}

/**
 * Build the provider. `pinnedSha` (from the task's checkpoint on a resume, when
 * `groundRef === "pinned"`) materializes that exact commit so a multi-turn
 * conversation reasons about one tree; otherwise HEAD is resolved fresh.
 */
export function makeRepoChatWorkspaceProvider(deps: ChatWorkspaceProviderDeps) {
  const audienceTrust = deps.audienceTrust ?? defaultAudienceTrust;

  const denyOnce = async (task: Task, reason: "no_link" | "stale" | "no_access"): Promise<void> => {
    if (!deps.onDenied) return;
    if (deps.claimOnce && !(await deps.claimOnce(`chat:ground-denial:${task.id}:${reason}`))) return;
    await deps.onDenied(task, reason);
  };

  return async (task: Task, opts: { pinnedSha?: string } = {}): Promise<ResolvedChatWorkspace | undefined> => {
    const repo = deps.repo;
    if (!repo || !deps.enabled) return undefined; // no repo / not opted in
    if (!task.invokingUserId) return undefined; // no user to check access for

    // Everything below is best-effort I/O (access check, visibility lookup,
    // clone): a failure degrades to **ungrounded**, never fails the task
    // (chat-repo.md §7). Policy *declines* (access denied / audience) return
    // undefined explicitly and are not errors. Any partially-materialized
    // workspace is disposed before returning.
    let resolved: ResolvedChatWorkspace | undefined;
    try {
      // Per-user access (§3.1 cond. 3): each denial surfaces the CTA once per
      // (task, reason). Not an error — a policy decision.
      const access = await deps.checkAccess(task.tenantId, task.invokingUserId, repo);
      if (access !== "ok") {
        await denyOnce(task, access);
        return undefined;
      }

      // Audience × visibility (§3.1 cond. 4), deny-by-default. `repoVisibility`
      // throws when it cannot PROVE visibility (e.g. a mis-scoped token can't
      // see the repo) — caught below → ungrounded, never treated as public.
      const visibility = await deps.repoVisibility(repo);
      if (!mayGround(visibility, audienceTrust(task))) return undefined;

      // Materialize read-only: pin the recorded sha when in pinned mode + resuming.
      const ref = deps.groundRef === "pinned" ? opts.pinnedSha : undefined;
      resolved = await deps.materialize(await deps.source(repo), ref);
      // The checkout is now a source — record it before any egress decision.
      await deps.onGrounded?.(task, { repo, sha: resolved.sha, visibility });
      return resolved;
    } catch (err) {
      await resolved?.dispose().catch(() => {});
      await deps.onError?.(task, err);
      return undefined;
    }
  };
}
