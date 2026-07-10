/**
 * Second half of the manifest flow: GitHub redirects back with a one-time
 * `code` that converts — unauthenticated, single use, expires in one hour —
 * into the newly created app's full credential set.
 */

export interface GithubAppCredentials {
  appId: number;
  slug: string;
  /** The app's private key (PEM) — written to .keys/, never printed. */
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  /** The app's settings page, e.g. https://github.com/apps/<slug>. */
  htmlUrl: string;
}

/**
 * Narrow the conversion response (deserialization edge: one mapping function
 * per shape, per the repo's `as` rule). Returns undefined on any missing or
 * mistyped field rather than trusting the wire.
 */
export function parseManifestConversion(json: unknown): GithubAppCredentials | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const { id, slug, pem, webhook_secret, client_id, client_secret, html_url } = o;
  if (
    typeof id !== "number" ||
    typeof slug !== "string" ||
    typeof pem !== "string" ||
    typeof webhook_secret !== "string" ||
    typeof client_id !== "string" ||
    typeof client_secret !== "string" ||
    typeof html_url !== "string"
  ) {
    return undefined;
  }
  return {
    appId: id,
    slug,
    pem,
    webhookSecret: webhook_secret,
    clientId: client_id,
    clientSecret: client_secret,
    htmlUrl: html_url,
  };
}

/** Exchange the redirect's one-time code for the app's credentials. */
export async function convertManifestCode(
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubAppCredentials> {
  const res = await fetchFn(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    },
  );
  if (res.status !== 201) {
    // The code is single-use and short-lived; a 404 here usually means it was
    // already redeemed or expired — re-run the registration for a fresh one.
    throw new Error(`GitHub App manifest conversion failed: HTTP ${res.status}`);
  }
  const creds = parseManifestConversion(await res.json());
  if (!creds) throw new Error("GitHub App manifest conversion returned an unexpected shape");
  return creds;
}
