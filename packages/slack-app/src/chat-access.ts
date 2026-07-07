import type { AudienceTrust, RepoAccessResult } from "@marathon/worker";

export type CheckAccess = (tenantId: string, userId: string, repo: string) => Promise<RepoAccessResult>;
export type AudienceTrustFn = (task: import("@marathon/core").Task) => AudienceTrust;

/**
 * Resolve the chat-grounding access wiring (chat-repo.md §3.1), extracted so the
 * security-sensitive decision is unit-tested directly.
 *
 * - `trustedDeployment` → the service credential's repo access authorizes
 *   everyone here: `checkAccess` short-circuits to `"ok"` and the audience is
 *   forced to `internal_confirmed` (so a private repo grounds in channels too).
 *   ONLY for a single-tenant/trusted surface.
 * - otherwise → verify each user with `identityChecker` when available, else
 *   fail closed to `"no_link"` (the master secret needed to read links is unset),
 *   and leave `audienceTrust` at the provider's default (DM → internal, else
 *   unknown).
 */
export function resolveChatAccessWiring(
  trustedDeployment: boolean,
  identityChecker: CheckAccess | undefined,
): { checkAccess: CheckAccess; audienceTrust: AudienceTrustFn | undefined } {
  if (trustedDeployment) {
    return { checkAccess: async () => "ok", audienceTrust: () => "internal_confirmed" };
  }
  return { checkAccess: identityChecker ?? (async () => "no_link"), audienceTrust: undefined };
}
