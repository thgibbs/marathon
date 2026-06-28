/**
 * Run the LIVE Marathon Slack app (Socket Mode). Long-running.
 *
 * Needs SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-), a model key
 * (OPENAI_API_KEY by default), and Postgres at DATABASE_URL. The bot must be in
 * the channel you mention it from.
 *
 *   make slack-app
 *   then in Slack: @marathon why did checkout errors spike?
 */
import { startSlackApp } from "@marathon/slack-app";

startSlackApp().catch((err) => {
  console.error("slack-app FAILED:", err);
  process.exit(1);
});
