import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { persistCredentials, startRegistrationServer } from "../src/register-github-app.js";
import type { GithubAppCredentials } from "../src/manifest-conversion.js";

const CREDS: GithubAppCredentials = {
  appId: 77,
  slug: "marathon-test",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  webhookSecret: "whsec",
  clientId: "Iv1.cid",
  clientSecret: "csec",
  htmlUrl: "https://github.com/apps/marathon-test",
};

const CONVERSION_BODY = JSON.stringify({
  id: CREDS.appId,
  slug: CREDS.slug,
  pem: CREDS.pem,
  webhook_secret: CREDS.webhookSecret,
  client_id: CREDS.clientId,
  client_secret: CREDS.clientSecret,
  html_url: CREDS.htmlUrl,
});

async function scratch(): Promise<{ dir: string; envPath: string; templatePath: string; keysDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "marathon-setup-"));
  return {
    dir,
    envPath: join(dir, ".env"),
    templatePath: join(dir, ".env.example"),
    keysDir: join(dir, ".keys"),
  };
}

describe("persistCredentials", () => {
  it("writes the PEM (0600) and fills an existing .env in place", async () => {
    const { envPath, templatePath, keysDir } = await scratch();
    await writeFile(envPath, "# app\nGITHUB_APP_ID=\nGITHUB_WEBHOOK_SECRET=\nGITHUB_APP_PRIVATE_KEY_PATH=\nGITHUB_APP_CLIENT_ID=\nGITHUB_APP_CLIENT_SECRET=\n");
    const { pemPath, envKeys } = await persistCredentials(CREDS, {
      envPath,
      envTemplatePath: templatePath,
      keysDir,
    });
    expect(pemPath).toBe(join(keysDir, "marathon-test.private-key.pem"));
    expect(await readFile(pemPath, "utf8")).toBe(CREDS.pem);
    expect((await stat(pemPath)).mode & 0o777).toBe(0o600);
    const env = await readFile(envPath, "utf8");
    expect(env).toContain("GITHUB_APP_ID=77");
    expect(env).toContain("GITHUB_WEBHOOK_SECRET=whsec");
    expect(env).toContain(`GITHUB_APP_PRIVATE_KEY_PATH=${pemPath}`);
    expect(env).toContain("# app\n");
    // No smee channel configured — the proxy key must not be invented.
    expect(env).not.toContain("MARATHON_WEBHOOK_PROXY=");
    expect(envKeys).not.toContain("MARATHON_WEBHOOK_PROXY");
  });

  it("starts from .env.example when .env does not exist and writes the smee channel", async () => {
    const { envPath, templatePath, keysDir } = await scratch();
    await writeFile(templatePath, "# template comment\nGITHUB_APP_ID=\nMARATHON_WEBHOOK_PROXY=\n");
    await persistCredentials(CREDS, {
      envPath,
      envTemplatePath: templatePath,
      keysDir,
      smeeChannel: "https://smee.io/chan",
    });
    const env = await readFile(envPath, "utf8");
    expect(env).toContain("# template comment");
    expect(env).toContain("GITHUB_APP_ID=77");
    expect(env).toContain("MARATHON_WEBHOOK_PROXY=https://smee.io/chan");
  });
});

describe("startRegistrationServer", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function boot(fetchFn: typeof fetch): Promise<{ base: string; done: Promise<unknown>; paths: Awaited<ReturnType<typeof scratch>> }> {
    const paths = await scratch();
    await writeFile(paths.envPath, "GITHUB_APP_ID=\n");
    const started = startRegistrationServer(
      {
        name: "marathon-test",
        webhookUrl: "https://smee.io/chan",
        smeeChannel: "https://smee.io/chan",
        port: 8895,
        envPath: paths.envPath,
        envTemplatePath: paths.templatePath,
        keysDir: paths.keysDir,
      },
      fetchFn,
    );
    server = started.server;
    await new Promise<void>((resolve) => started.server.listen(0, "127.0.0.1", resolve));
    const addr = started.server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${addr.port}`, done: started.done, paths };
  }

  it("serves the registration page at /", async () => {
    const { base } = await boot(fetch);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Register GitHub App");
    expect(html).toContain("github.com/settings/apps/new");
  });

  it("converts the callback code, persists credentials, and resolves done", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response(CONVERSION_BODY, { status: 201 }))) as typeof fetch;
    const { base, done, paths } = await boot(fetchFn);
    const res = await fetch(`${base}/callback?code=onetime`);
    expect(res.status).toBe(200);
    const result = (await done) as { installUrl: string; pemPath: string };
    expect(result.installUrl).toBe("https://github.com/apps/marathon-test/installations/new");
    const env = await readFile(paths.envPath, "utf8");
    expect(env).toContain("GITHUB_APP_ID=77");
    expect(await readFile(result.pemPath, "utf8")).toBe(CREDS.pem);
  });

  it("rejects a callback without a code", async () => {
    const { base } = await boot(fetch);
    const res = await fetch(`${base}/callback`);
    expect(res.status).toBe(400);
  });

  it("404s unknown paths", async () => {
    const { base } = await boot(fetch);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("rejects done and answers 500 when the conversion fails", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))) as typeof fetch;
    const { base, done } = await boot(fetchFn);
    // Attach the rejection handler BEFORE triggering the callback — done
    // rejects while the fetch below is still in flight.
    const rejection = expect(done).rejects.toThrow(/HTTP 404/);
    const res = await fetch(`${base}/callback?code=stale`);
    expect(res.status).toBe(500);
    await rejection;
  });
});
