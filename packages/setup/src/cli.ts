/**
 * `make register-github-app` / `pnpm --filter @marathon/setup register-github-app`
 *
 * One-click GitHub App registration for a Marathon deployment:
 *   1. (dev default) create a smee.io channel as the webhook target —
 *      production passes `--webhook-url https://…/webhooks/github` instead;
 *   2. serve the manifest page locally and wait for the human to click
 *      "Register GitHub App" and confirm on github.com;
 *   3. exchange the redirect code and write GITHUB_APP_ID,
 *      GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET,
 *      GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET (and, in dev,
 *      MARATHON_WEBHOOK_PROXY) into .env, and the key into .keys/.
 *
 * Flags: --name <app name>   (default marathon-<random>; editable on GitHub)
 *        --org <org>         (register under an organization)
 *        --webhook-url <url> (production webhook endpoint; skips smee)
 *        --port <port>       (local page/callback port, default 8895)
 */
import { randomBytes } from "node:crypto";
import { createSmeeChannel } from "./smee.js";
import { startRegistrationServer } from "./register-github-app.js";

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const org = readFlag(args, "--org");
  const name = readFlag(args, "--name") ?? `marathon-${randomBytes(3).toString("hex")}`;
  const port = Number(readFlag(args, "--port") ?? "8895");
  const explicitWebhook = readFlag(args, "--webhook-url");

  let webhookUrl = explicitWebhook;
  let smeeChannel: string | undefined;
  if (webhookUrl === undefined) {
    smeeChannel = await createSmeeChannel();
    webhookUrl = smeeChannel;
    console.log(`created dev webhook channel: ${smeeChannel}`);
    console.log("(production instead: --webhook-url https://<host>/webhooks/github)");
  }

  const { server, done } = startRegistrationServer({
    name,
    org,
    port,
    webhookUrl,
    smeeChannel,
    envPath: ".env",
    envTemplatePath: ".env.example",
    keysDir: ".keys",
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`\nOpen http://localhost:${port} and click "Register GitHub App".`);
    console.log(`(the app name "${name}" is editable on GitHub's confirmation screen)\n`);
  });

  try {
    const result = await done;
    console.log(`✓ registered GitHub App "${result.creds.slug}" (id ${result.creds.appId})`);
    console.log(`✓ private key: ${result.pemPath}`);
    console.log(`✓ .env updated: ${result.envKeys.join(", ")}`);
    console.log("\nNext steps:");
    console.log(`  1. Install the app on your target repo: ${result.installUrl}`);
    console.log("     (registration alone grants no repo access — this step does)");
    console.log("  2. In .env, set GITHUB_OWNER (the target repo's owner) and MARATHON_TENANT.");
    console.log("  3. Set `repo: <owner>/<name>` in agents/forge.yaml.");
    console.log("  4. Run: make github-app");
  } finally {
    server.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
