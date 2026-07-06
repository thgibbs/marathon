/**
 * GitHub App USER authorization (§7.20 / §2b #10) — the identity-only OAuth
 * leg of Slack-initiated identity linking. Distinct from installation auth
 * (`app-auth.ts`, which authenticates Marathon-as-app): this proves a HUMAN
 * controls a GitHub login, and yields the minimal-scope user-to-server token
 * that doubles as the per-user access checker ("can U read repo R?" is asked
 * of GitHub *as U*).
 */

export interface UserOAuthConfig {
  /** The GitHub App's OAuth client id (`GITHUB_APP_CLIENT_ID`). */
  clientId: string;
  /** The GitHub App's OAuth client secret (`GITHUB_APP_CLIENT_SECRET`). */
  clientSecret: string;
  /** Override for GitHub Enterprise; default github.com. */
  webBaseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Where the user's browser goes to authorize (state = the signed link token). */
export function githubAuthorizeUrl(cfg: { clientId: string; webBaseUrl?: string }, state: string): string {
  const base = cfg.webBaseUrl ?? "https://github.com";
  const q = new URLSearchParams({ client_id: cfg.clientId, state });
  return `${base}/login/oauth/authorize?${q}`;
}

/** Exchange the callback `code` for a user-to-server access token. */
export async function exchangeOAuthCode(cfg: UserOAuthConfig, code: string): Promise<{ accessToken: string }> {
  const base = cfg.webBaseUrl ?? "https://github.com";
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${base}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "marathon" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
  });
  if (!res.ok) throw new Error(`github oauth exchange failed (${res.status})`);
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`github oauth exchange failed: ${j.error_description ?? j.error ?? "no token"}`);
  return { accessToken: j.access_token };
}

/** The authenticated user's login — the identity being proven. */
export async function fetchGithubLogin(cfg: { apiBaseUrl?: string; fetchImpl?: typeof fetch }, token: string): Promise<string> {
  const base = cfg.apiBaseUrl ?? "https://api.github.com";
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${base}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "marathon" },
  });
  if (!res.ok) throw new Error(`github /user failed (${res.status})`);
  const j = (await res.json()) as { login?: string };
  if (!j.login) throw new Error("github /user returned no login");
  return j.login;
}

/**
 * The per-user access check (§7.20): ask GitHub *as the user* whether they can
 * see the repo. `bad_token` means the stored token no longer works — the
 * caller marks the link `stale` and denies until re-link.
 */
export async function checkRepoAsUser(
  cfg: { apiBaseUrl?: string; fetchImpl?: typeof fetch },
  token: string,
  repo: string,
): Promise<"ok" | "no_access" | "bad_token"> {
  const base = cfg.apiBaseUrl ?? "https://api.github.com";
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${base}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "marathon" },
  });
  if (res.ok) return "ok";
  if (res.status === 401) return "bad_token";
  // 403/404 both mean "this user can't see it" (GitHub hides private repos as 404).
  return "no_access";
}
