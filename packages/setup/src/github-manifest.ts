/**
 * GitHub App registration via the manifest flow ("Registering a GitHub App
 * from a manifest" in GitHub's docs). Why per-deployment apps instead of one
 * shared upstream app: a GitHub App's private key can mint installation
 * tokens for EVERY installation of that app, and its single webhook URL
 * delivers every installation's events to whoever hosts that endpoint.
 * Sharing the upstream author's app would give each open-source deployment
 * a credential (and an event stream) spanning all the others. Stamping a
 * fresh app per deployment from this manifest keeps blast radius and event
 * delivery scoped to one deployment while guaranteeing permission/event
 * parity with upstream.
 *
 * The flow: a local page (registrationPageHtml) POSTs the manifest to
 * github.com; the human confirms once (the app name is editable on that
 * screen); GitHub redirects the browser back to `redirect_url` with a
 * one-time code that manifest-conversion.ts exchanges for the credentials.
 */

/** Repository permissions the document surface actually uses (quickstart §3). */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
} as const;

/** Webhook events surface-github's parser consumes (parse.ts). */
export const GITHUB_APP_EVENTS = [
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

/** The manifest document GitHub's "create from manifest" endpoint accepts. */
export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface GithubAppManifestOptions {
  /** Proposed app name (globally unique on GitHub; editable at confirmation). */
  name: string;
  /** Where GitHub delivers webhooks — a smee channel (dev) or public URL. */
  webhookUrl: string;
  /** Local callback GitHub redirects to with the one-time conversion code. */
  redirectUrl: string;
  /** App homepage shown on the app's public page. */
  homepageUrl?: string;
}

export function buildGithubAppManifest(opts: GithubAppManifestOptions): GithubAppManifest {
  return {
    name: opts.name,
    url: opts.homepageUrl ?? "https://github.com/thgibbs/marathon",
    hook_attributes: { url: opts.webhookUrl },
    redirect_url: opts.redirectUrl,
    // Private: installable only by the account that creates it. Every
    // deployment registers its own app, so none needs to be public.
    public: false,
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    default_events: [...GITHUB_APP_EVENTS],
  };
}

/** Where the manifest form must POST: personal account or an organization. */
export function manifestPostUrl(org?: string): string {
  return org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The one-button local page: a form whose hidden `manifest` field carries the
 * JSON document. GitHub renders a confirmation screen (name editable there),
 * then redirects back to the manifest's `redirect_url` with `?code=…`.
 */
export function registrationPageHtml(manifest: GithubAppManifest, postUrl: string): string {
  const json = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Register Marathon's GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
  <h1>Register this deployment's GitHub App</h1>
  <p>This creates a <strong>private GitHub App owned by you</strong> with exactly the
  permissions (${escapeHtml(Object.entries(GITHUB_APP_PERMISSIONS).map(([k, v]) => `${k}: ${v}`).join(", "))})
  and webhook events Marathon's document surface needs. You can edit the app
  name on the next screen. After GitHub redirects back here, the credentials
  are written to <code>.env</code> and the private key to <code>.keys/</code> —
  nothing is sent anywhere else.</p>
  <form action="${escapeHtml(postUrl)}" method="post">
    <input type="hidden" name="manifest" value="${json}">
    <button type="submit" style="font-size: 1.1rem; padding: 0.6rem 1.4rem;">Register GitHub App</button>
  </form>
</body>
</html>`;
}
