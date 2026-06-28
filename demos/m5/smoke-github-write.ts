/**
 * LOCAL-ONLY smoke for REAL GitHub write tools (NOT run in CI).
 *
 * Creates an issue, comments on it, then closes it (cleanup) on a real repo via
 * the PAT (secret/github -> GITHUB_TOKEN). Verifies the non-destructive write
 * tools end-to-end. (Merge is destructive/approval-gated and needs a real PR, so
 * it's exercised by the deterministic demo, not here.)
 *
 *   make smoke-github-write            (defaults to thgibbs/agentp-demo)
 *   SMOKE_REPO=owner/name make smoke-github-write
 */
import { EnvSecretStore } from "@marathon/config";
import { HttpGithubClient } from "@marathon/connector-github";

async function main(): Promise<void> {
  const repo = process.env.SMOKE_REPO ?? "thgibbs/agentp-demo";
  const token = await new EnvSecretStore().get("secret/github");
  if (!token) throw new Error("no github token (GITHUB_TOKEN)");
  const client = new HttpGithubClient(token);

  console.log(`[smoke-github-write] creating issue in ${repo} ...`);
  const issue = await client.createIssue(repo, "[marathon] write smoke", "Created by Marathon M5 smoke. Safe to close.");
  console.log(`  created #${issue.number} ${issue.url}`);

  console.log("[smoke-github-write] commenting ...");
  await client.commentIssue(repo, issue.number, "Marathon M5 write smoke comment.");

  console.log("[smoke-github-write] closing (cleanup) ...");
  await client.closeIssue(repo, issue.number);

  console.log("smoke-github-write OK");
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  // Fine-grained PATs need "Issues: write" (and "Pull requests: write" for merge).
  if (msg.includes("403") && /not accessible|Resource not accessible/i.test(msg)) {
    console.warn(
      "smoke-github-write SKIPPED: the PAT lacks 'Issues: write'.\n" +
        "Enable Issues (and Pull requests) write on the fine-grained token to verify live.",
    );
    process.exit(0);
  }
  console.error("smoke-github-write FAILED:", err);
  process.exit(1);
});
