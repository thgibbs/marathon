/**
 * The per-user repo access checker (§7.20 / chat-repo.md §3.1): "can this
 * Marathon user read repo R?", answered *as the user* via their stored,
 * encrypted user-to-server token. Lives here (not github-app) so BOTH the
 * GitHub app and the chat surfaces can gate on it without a package cycle — it
 * needs only the DB, the master secret, and {@link checkRepoAsUser}.
 */
import { decryptSecret, type Id, type NewAuditEvent, type UserIdentity } from "@marathon/core";
import { checkRepoAsUser } from "./user-oauth";

/** The DB surface the checker needs (`Database` satisfies it). */
export interface UserAccessDb {
  findUserIdentityByUser(tenantId: Id, userId: Id, surfaceType: "github"): Promise<UserIdentity | null>;
  setUserIdentityStatus(id: Id, status: "active" | "stale" | "revoked"): Promise<void>;
  write(event: NewAuditEvent): Promise<unknown>;
}

export interface UserRepoAccessDeps {
  db: UserAccessDb;
  /** Master secret (`MARATHON_SECRET_KEY`) — decrypts the at-rest user token. */
  masterSecret: string;
  /** GitHub API config (base URL / fetch); defaults to github.com + global fetch. */
  api?: { apiBaseUrl?: string; fetchImpl?: typeof fetch };
}

export type UserRepoAccess = "ok" | "no_access" | "no_link" | "stale";

/**
 * Outcomes:
 *   ok | no_access  — a live answer from GitHub;
 *   no_link         — no verified GitHub link (deny; offer /marathon link github);
 *   stale           — the stored token no longer works; the link was JUST
 *                     marked stale (audited) — deny until re-link.
 */
export function makeUserRepoAccessChecker(deps: UserRepoAccessDeps) {
  return async (tenantId: Id, userId: Id, repo: string): Promise<UserRepoAccess> => {
    const identity = await deps.db.findUserIdentityByUser(tenantId, userId, "github");
    if (!identity?.credentialRef || identity.status !== "active" || identity.verificationMethod !== "oauth") {
      return identity?.status === "stale" ? "stale" : "no_link";
    }
    const token = decryptSecret(identity.credentialRef, deps.masterSecret);
    const result = await checkRepoAsUser(deps.api ?? {}, token, repo);
    if (result === "bad_token") {
      await deps.db.setUserIdentityStatus(identity.id, "stale");
      await deps.db.write({
        tenantId,
        actorUserId: userId,
        eventType: "identity.stale",
        targetType: "user_identity",
        targetId: identity.id,
        summary: `GitHub link '${identity.externalId}' marked stale — stored token rejected`,
      });
      return "stale";
    }
    return result;
  };
}
