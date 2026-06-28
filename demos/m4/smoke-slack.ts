/**
 * LOCAL-ONLY smoke for the REAL Slack surface (NOT run in CI).
 *
 *   - auth.test with the bot token (xoxb-)
 *   - Socket Mode connectivity with the app token (xapp-) — proves inbound works
 *     without a public URL
 *   - if SLACK_SMOKE_CHANNEL is set, posts a real threaded test message (outbound)
 *
 *   make smoke-slack
 *   SLACK_SMOKE_CHANNEL=C0123 make smoke-slack
 */
import { RealSlackClient, verifySocketMode } from "@marathon/surface-slack";

function envVal(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

async function main(): Promise<void> {
  const botToken = envVal("SLACK_BOT_TOKEN");
  const appToken = envVal("SLACK_APP_TOKEN");
  if (!botToken) throw new Error("SLACK_BOT_TOKEN (xoxb-) not set");

  console.log("[smoke-slack] auth.test (bot token) ...");
  const res = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const auth = (await res.json()) as { ok: boolean; team?: string; user?: string; error?: string };
  if (!auth.ok) throw new Error(`auth.test failed: ${auth.error}`);
  console.log(`  ok: team=${auth.team} bot=${auth.user}`);

  if (appToken) {
    console.log("[smoke-slack] Socket Mode connectivity (app token) ...");
    await verifySocketMode(appToken);
    console.log("  ok: received 'hello' over the Socket Mode connection");
  } else {
    console.log("[smoke-slack] no SLACK_APP_TOKEN — skipping Socket Mode check");
  }

  const channel = envVal("SLACK_SMOKE_CHANNEL");
  if (channel) {
    console.log(`[smoke-slack] posting a test message to ${channel} ...`);
    const client = new RealSlackClient(botToken);
    const sent = await client.postMessage(channel, "Marathon M4 smoke ✅ (you can ignore this).");
    console.log(`  posted ts=${sent.ts}`);
  } else {
    console.log("[smoke-slack] set SLACK_SMOKE_CHANNEL=C... (bot must be in it) to test posting");
  }

  console.log("smoke-slack OK");
}

main().catch((err) => {
  console.error("smoke-slack FAILED:", err);
  process.exit(1);
});
