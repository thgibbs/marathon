/**
 * The local registration flow: serve the one-button manifest page, receive
 * GitHub's redirect, convert the code, and persist the credentials — private
 * key to `.keys/<slug>.private-key.pem` (git-ignored, mode 0600) and the
 * credential fields into `.env` (created from `.env.example` if absent).
 * Secrets are written to disk only; nothing is printed or sent elsewhere.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { upsertEnvValues } from "./env-file.js";
import {
  buildGithubAppManifest,
  manifestPostUrl,
  registrationPageHtml,
} from "./github-manifest.js";
import { convertManifestCode, type GithubAppCredentials } from "./manifest-conversion.js";

export interface RegistrationConfig {
  /** Proposed app name (editable on GitHub's confirmation screen). */
  name: string;
  /** Webhook delivery URL — a smee channel (dev) or public endpoint. */
  webhookUrl: string;
  /** Set when webhookUrl is a smee channel: also written to MARATHON_WEBHOOK_PROXY. */
  smeeChannel?: string;
  /** Register under an organization instead of the personal account. */
  org?: string;
  /** Local port for the registration page + callback. */
  port: number;
  /**
   * Per-run secret segment of the callback path (default: 16 random bytes).
   * Binds GitHub's redirect to THIS registration attempt: without it the
   * predictable /callback path would let any local or cross-origin request
   * redeem an unrelated manifest code and overwrite .env/.keys while the
   * helper is waiting. Injectable for tests only.
   */
  callbackToken?: string;
  homepageUrl?: string;
  envPath: string;
  envTemplatePath: string;
  keysDir: string;
}

export interface RegistrationResult {
  creds: GithubAppCredentials;
  pemPath: string;
  /** Where the human finishes: installing the app on the target repo. */
  installUrl: string;
  /** The .env keys that were written (names only — values stay on disk). */
  envKeys: string[];
}

/** Write the PEM + fill the credential fields into .env. */
export async function persistCredentials(
  creds: GithubAppCredentials,
  cfg: Pick<RegistrationConfig, "envPath" | "envTemplatePath" | "keysDir" | "smeeChannel">,
): Promise<{ pemPath: string; envKeys: string[] }> {
  const pemPath = join(cfg.keysDir, `${creds.slug}.private-key.pem`);
  await mkdir(cfg.keysDir, { recursive: true });
  await writeFile(pemPath, creds.pem, { mode: 0o600 });

  let envContent: string;
  try {
    envContent = await readFile(cfg.envPath, "utf8");
  } catch {
    // First install: start from the commented template so the .env the human
    // ends up with still explains every field.
    envContent = await readFile(cfg.envTemplatePath, "utf8");
  }
  const updates: Record<string, string> = {
    GITHUB_APP_ID: String(creds.appId),
    GITHUB_APP_PRIVATE_KEY_PATH: pemPath,
    GITHUB_WEBHOOK_SECRET: creds.webhookSecret,
    GITHUB_APP_CLIENT_ID: creds.clientId,
    GITHUB_APP_CLIENT_SECRET: creds.clientSecret,
  };
  if (cfg.smeeChannel !== undefined) updates.MARATHON_WEBHOOK_PROXY = cfg.smeeChannel;
  await writeFile(cfg.envPath, upsertEnvValues(envContent, updates));
  return { pemPath, envKeys: Object.keys(updates) };
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Marathon — app registered</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>GitHub App registered ✓</h1>
<p>Credentials were written to <code>.env</code> and the private key to
<code>.keys/</code>. Return to the terminal for the remaining steps —
installing the app on your target repository is the important one.</p>
</body></html>`;

/**
 * Start the local flow. `done` resolves once GitHub has redirected back and
 * the credentials are persisted, or rejects on a conversion/persist failure;
 * the caller closes the server either way.
 */
export function startRegistrationServer(
  cfg: RegistrationConfig,
  fetchFn: typeof fetch = fetch,
): { server: Server; done: Promise<RegistrationResult> } {
  let resolveDone: (r: RegistrationResult) => void;
  let rejectDone: (e: Error) => void;
  const done = new Promise<RegistrationResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const callbackToken = cfg.callbackToken ?? randomBytes(16).toString("hex");
  const callbackPath = `/callback/${callbackToken}`;
  const manifest = buildGithubAppManifest({
    name: cfg.name,
    webhookUrl: cfg.webhookUrl,
    redirectUrl: `http://localhost:${cfg.port}${callbackPath}`,
    homepageUrl: cfg.homepageUrl,
  });
  const page = registrationPageHtml(manifest, manifestPostUrl(cfg.org));
  // Accept only the first callback: once a code is being redeemed, later
  // requests must not be able to overwrite the persisted credentials.
  let redeemed = false;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${cfg.port}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      if (url.pathname === callbackPath) {
        if (redeemed) {
          res.writeHead(409, { "content-type": "text/plain" }).end("already redeemed");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" }).end("missing ?code");
          return;
        }
        redeemed = true;
        const creds = await convertManifestCode(code, fetchFn);
        const { pemPath, envKeys } = await persistCredentials(creds, cfg);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);
        resolveDone({
          creds,
          pemPath,
          installUrl: `${creds.htmlUrl}/installations/new`,
          envKeys,
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("registration failed — see terminal");
      rejectDone(e instanceof Error ? e : new Error(String(e)));
    });
  });
  return { server, done };
}
