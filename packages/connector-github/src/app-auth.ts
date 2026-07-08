/**
 * GitHub App installation auth (§2b #15): App JWT → installation access
 * token, cached (~1h expiry) and refreshed early or on demand. With this,
 * every GitHub effect — REST via {@link HttpGithubClient} and the brokered
 * `gh`/`git` credential — authors as `<app-slug>[bot]` instead of the
 * operator's PAT user, which also makes the "filter Marathon's own posts"
 * rule (§2b #11) structural: bot-typed authors never trigger runs.
 *
 * The integration seam is the existing {@link SecretStore}: wrap the store
 * with {@link withInstallationToken} and every consumer that resolves
 * `secret/github` at use time (the exec-tool broker, the client factory, the
 * per-task clone source) transparently receives a fresh installation token.
 * The PAT path (`GITHUB_TOKEN`) stays the quickstart fallback.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SecretStore } from "@marathon/config";

/** Anything that can produce a current token (force = discard the cache). */
export interface GithubTokenSource {
  getToken(forceRefresh?: boolean): Promise<string>;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * A short-lived RS256 App JWT (GitHub caps validity at 10 minutes; `iat` is
 * backdated 60s against clock drift). Exported for tests.
 */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(normalizePrivateKey(privateKeyPem)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * PEM keys frequently arrive through env files with literal `\n` escapes;
 * normalize them back to real newlines. Exported for tests.
 */
export function normalizePrivateKey(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/** A PEM private key block of any flavor (PKCS#1 `RSA PRIVATE KEY`, PKCS#8 `PRIVATE KEY`). */
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Resolve the App private key from the environment. `GITHUB_APP_PRIVATE_KEY_PATH`
 * (a path to the downloaded `.pem`) takes precedence — the ergonomic local-dev
 * form; otherwise `GITHUB_APP_PRIVATE_KEY` holds the PEM inline (the
 * production / secret-manager form). Returns `undefined` when neither is set.
 *
 * Throws a precise error when the resolved value is not a PEM private key. The
 * classic mistake is pasting the key's **`SHA256:…` fingerprint** (shown in the
 * GitHub App UI next to each key) instead of the downloaded `.pem` contents —
 * that surfaces here at boot, not as an opaque OpenSSL `DECODER unsupported`
 * failure deep in the first API call. Exported for tests.
 */
export function resolveAppPrivateKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  let key: string | undefined;
  if (path) {
    try {
      key = readFileSync(path, "utf8").trim();
    } catch (e) {
      throw new Error(
        `GITHUB_APP_PRIVATE_KEY_PATH: cannot read '${path}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    key = env.GITHUB_APP_PRIVATE_KEY?.trim() || undefined;
  }
  if (key === undefined) return undefined;
  if (!PEM_PRIVATE_KEY_RE.test(normalizePrivateKey(key))) {
    const src = path ? `GITHUB_APP_PRIVATE_KEY_PATH ('${path}')` : "GITHUB_APP_PRIVATE_KEY";
    throw new Error(
      `${src} is not a PEM private key (expected a "-----BEGIN … PRIVATE KEY-----" block). ` +
        "Download the key from the GitHub App settings (Private keys → Generate a private key) and use the .pem " +
        "file's contents — NOT the \"SHA256:…\" fingerprint shown in the UI.",
    );
  }
  return key;
}

export interface InstallationTokenOptions {
  appId: string;
  privateKey: string;
  /** The account (org/user) the App is installed on — resolves the installation. */
  owner: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
}

/** Refresh when the cached token is within this window of its expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Mints and caches installation access tokens. `getToken()` returns the
 * cached token until ~5 minutes before its expiry; `getToken(true)` discards
 * the cache first (the 401-retry path — GitHub may revoke early).
 */
export class InstallationTokenProvider implements GithubTokenSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private installationId: number | undefined;
  private cached: { token: string; expiresAtMs: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(private readonly opts: InstallationTokenOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) this.cached = undefined;
    if (this.cached && this.cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    // Single-flight: concurrent tool calls share one mint.
    this.pending ??= this.mint().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async mint(): Promise<string> {
    const jwt = createAppJwt(this.opts.appId, this.opts.privateKey, Math.floor(this.now() / 1000));
    const installationId = await this.resolveInstallationId(jwt);
    const res = await this.fetchImpl(`${this.baseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: appHeaders(jwt),
    });
    if (!res.ok) {
      throw new Error(`github app token mint failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const j = (await res.json()) as { token?: string; expires_at?: string };
    if (!j.token) throw new Error("github app token mint returned no token");
    const expiresAtMs = j.expires_at ? Date.parse(j.expires_at) : this.now() + 60 * 60 * 1000;
    this.cached = { token: j.token, expiresAtMs };
    return j.token;
  }

  private async resolveInstallationId(jwt: string): Promise<number> {
    if (this.installationId !== undefined) return this.installationId;
    // Owner-level lookup: works for both org and user installations.
    for (const kind of ["orgs", "users"]) {
      const res = await this.fetchImpl(`${this.baseUrl}/${kind}/${this.opts.owner}/installation`, {
        headers: appHeaders(jwt),
      });
      if (res.ok) {
        const j = (await res.json()) as { id?: number };
        if (typeof j.id === "number") {
          this.installationId = j.id;
          return j.id;
        }
      }
    }
    throw new Error(`github app is not installed on '${this.opts.owner}' (or the App credentials are wrong)`);
  }
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "marathon",
  };
}

/**
 * Decorate a secret store so `ref` (default `secret/github`) resolves to a
 * fresh installation token; every other ref passes through. This is how the
 * exec-tool broker and the client factory pick up App auth with no changes.
 */
export function withInstallationToken(
  inner: SecretStore,
  source: GithubTokenSource,
  ref = "secret/github",
): SecretStore {
  return {
    async get(r: string): Promise<string | undefined> {
      if (r === ref) return source.getToken();
      return inner.get(r);
    },
  };
}

/**
 * Build the deployment's GitHub auth from the environment (§2b #15): when
 * `GITHUB_APP_ID` + a private key (`GITHUB_APP_PRIVATE_KEY` inline, or
 * `GITHUB_APP_PRIVATE_KEY_PATH` pointing at the downloaded `.pem`) are set, App
 * installation auth (posts author as `<app-slug>[bot]`); otherwise the PAT from
 * the inner store (quickstart fallback). Returns the (possibly decorated) secret
 * store plus a token source for consumers that hold a client across token
 * expiries. A malformed key with an App ID present fails loud here at boot
 * ({@link resolveAppPrivateKey}), not at the first API call.
 */
export function githubAuthFromEnv(
  inner: SecretStore,
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): { secrets: SecretStore; tokenSource: GithubTokenSource | undefined; mode: "app" | "token" } {
  const appId = env.GITHUB_APP_ID?.trim();
  const hasKeySource = Boolean(env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() || env.GITHUB_APP_PRIVATE_KEY?.trim());
  if (appId && hasKeySource) {
    const privateKey = resolveAppPrivateKey(env)!;
    const provider = new InstallationTokenProvider({ appId, privateKey, owner });
    return { secrets: withInstallationToken(inner, provider), tokenSource: provider, mode: "app" };
  }
  return { secrets: inner, tokenSource: undefined, mode: "token" };
}
