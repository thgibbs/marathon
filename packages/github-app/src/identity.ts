/**
 * Identity linking (§7.20 / §2b #10) — the GitHub-app side of the Slack →
 * GitHub OAuth flow, framework-pure (the live server routes into it):
 *
 *   GET /auth/github/start?token=T     verify the signed link token, redirect
 *                                      the browser to GitHub App user
 *                                      authorization (state carries T);
 *   GET /auth/github/callback?code&state
 *                                      verify state, BURN the nonce
 *                                      (single-use), exchange the code, prove
 *                                      the GitHub login, and write the
 *                                      `UserIdentity` (verification: oauth)
 *                                      onto the Slack-proven user.
 *
 * The user-to-server token is stored encrypted (AES-256-GCM under the master
 * secret) in `credential_ref` — the per-user access checker asks GitHub *as
 * the user*; a dead token marks the link `stale` → deny until re-link.
 */
import {
  decryptSecret,
  encryptSecret,
  verifyLinkToken,
  type Id,
  type NewAuditEvent,
  type UserIdentity,
} from "@marathon/core";
import {
  checkRepoAsUser,
  exchangeOAuthCode,
  fetchGithubLogin,
  githubAuthorizeUrl,
  type UserOAuthConfig,
} from "@marathon/connector-github";

/** What the flow needs from the database (`Database` satisfies this). */
export interface IdentityDb {
  claim(key: string): Promise<boolean>;
  findOrCreateUserByIdentity(tenantId: Id, surfaceType: "slack", externalId: string): Promise<{ id: Id }>;
  findUserIdentityByUser(tenantId: Id, userId: Id, surfaceType: "github"): Promise<UserIdentity | null>;
  linkUserIdentity(input: {
    tenantId: Id;
    userId: Id;
    surfaceType: "github";
    externalId: string;
    verificationMethod: "oauth";
    credentialRef?: string;
  }): Promise<UserIdentity>;
  setUserIdentityStatus(id: Id, status: "active" | "stale" | "revoked"): Promise<void>;
  write(event: NewAuditEvent): Promise<unknown>;
}

export interface IdentityLinkDeps {
  db: IdentityDb;
  /** The deployment master secret (`MARATHON_SECRET_KEY`) — link-token + at-rest key. */
  masterSecret: string;
  oauth: UserOAuthConfig;
}

export interface IdentityHttpResponse {
  status: number;
  body?: string;
  /** 302 target when set. */
  location?: string;
  contentType?: string;
}

function page(status: number, title: string, detail: string): IdentityHttpResponse {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto"><h2>${title}</h2><p>${detail}</p></body>`,
  };
}

/** GET /auth/github/start?token=… — the single-use signed URL the Slack app minted. */
export function handleLinkStart(deps: IdentityLinkDeps, url: URL): IdentityHttpResponse {
  const token = url.searchParams.get("token") ?? "";
  const payload = verifyLinkToken(token, deps.masterSecret);
  if (!payload) {
    return page(400, "Link expired or invalid", "Ask Marathon for a fresh link with <code>/marathon link github</code>.");
  }
  // The nonce burns at the CALLBACK (one redemption); the start hop only
  // validates and forwards — a re-visited start URL cannot mint a second link.
  return { status: 302, location: githubAuthorizeUrl(deps.oauth, token) };
}

/** GET /auth/github/callback?code=…&state=… — completes the proof and writes the link. */
export async function handleLinkCallback(deps: IdentityLinkDeps, url: URL): Promise<IdentityHttpResponse> {
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const payload = verifyLinkToken(state, deps.masterSecret);
  if (!payload || !code) {
    return page(400, "Link expired or invalid", "Ask Marathon for a fresh link with <code>/marathon link github</code>.");
  }
  // Single-use: burn the nonce before any effect; a replayed callback is a no-op.
  if (!(await deps.db.claim(`link:nonce:${payload.nonce}`))) {
    return page(409, "Link already used", "This link was already redeemed. Ask for a fresh one if you need to re-link.");
  }

  const { accessToken } = await exchangeOAuthCode(deps.oauth, code);
  const login = await fetchGithubLogin(deps.oauth, accessToken);

  // The Slack side of the identity was proven when the authenticated Socket
  // Mode interaction minted the token; the OAuth leg just proved the GitHub
  // side. Join them on ONE Marathon user.
  const user = await deps.db.findOrCreateUserByIdentity(payload.tenantId, "slack", payload.slackUserId);
  const identity = await deps.db.linkUserIdentity({
    tenantId: payload.tenantId,
    userId: user.id,
    surfaceType: "github",
    externalId: login,
    verificationMethod: "oauth",
    credentialRef: encryptSecret(accessToken, deps.masterSecret),
  });
  await deps.db.write({
    tenantId: payload.tenantId,
    actorUserId: user.id,
    eventType: "identity.linked",
    targetType: "user_identity",
    targetId: identity.id,
    summary: `Linked GitHub login '${login}' via OAuth (Slack user ${payload.slackUserId})`,
  });

  return page(
    200,
    "GitHub linked",
    `Marathon linked <b>@${login}</b> to your Slack identity. You can close this tab and head back to Slack.`,
  );
}

/**
 * Route an incoming request into the flow; null when the path is not ours
 * (the caller falls through to its other routes).
 */
export async function handleIdentityRequest(
  deps: IdentityLinkDeps,
  method: string,
  url: URL,
): Promise<IdentityHttpResponse | null> {
  if (method !== "GET") return null;
  if (url.pathname === "/auth/github/start") return handleLinkStart(deps, url);
  if (url.pathname === "/auth/github/callback") return handleLinkCallback(deps, url);
  return null;
}

/**
 * The per-user access checker (§7.20): "can this Marathon user read repo R?",
 * answered as the user via their stored token. Outcomes:
 *   ok | no_access  — a live answer from GitHub;
 *   no_link         — the user has no verified GitHub link (deny; offer /marathon link github);
 *   stale           — the stored token no longer works; the link was JUST
 *                     marked stale (audited) — deny until re-link.
 */
export function makeUserRepoAccessChecker(deps: IdentityLinkDeps) {
  return async (tenantId: Id, userId: Id, repo: string): Promise<"ok" | "no_access" | "no_link" | "stale"> => {
    const identity = await deps.db.findUserIdentityByUser(tenantId, userId, "github");
    if (!identity?.credentialRef || identity.status !== "active" || identity.verificationMethod !== "oauth") {
      return identity?.status === "stale" ? "stale" : "no_link";
    }
    const token = decryptSecret(identity.credentialRef, deps.masterSecret);
    const result = await checkRepoAsUser(deps.oauth, token, repo);
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
