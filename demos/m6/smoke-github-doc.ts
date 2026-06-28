/**
 * LOCAL-ONLY smoke for the REAL GitHub document surface (NOT run in CI).
 *
 * Creates a real markdown doc on a branch, opens a PR, comments on it, then
 * cleans up (closes the PR + deletes the branch) on a real repo via the PAT.
 *
 *   make smoke-github-doc            (defaults to thgibbs/agentp-demo)
 */
import { EnvSecretStore } from "@marathon/config";
import { HttpGithubClient } from "@marathon/connector-github";

async function main(): Promise<void> {
  const repo = process.env.SMOKE_REPO ?? "thgibbs/agentp-demo";
  const token = await new EnvSecretStore().get("secret/github");
  if (!token) throw new Error("no github token (GITHUB_TOKEN)");
  const client = new HttpGithubClient(token);

  const stamp = Date.now();
  const branch = `marathon/doc-smoke-${stamp}`;
  const path = `docs/marathon-smoke-${stamp}.md`;

  console.log(`[smoke-github-doc] base sha for ${repo}#main ...`);
  const { sha } = await client.getRef(repo, "heads/main");

  console.log(`[smoke-github-doc] create branch ${branch} + file ${path} ...`);
  await client.createBranch(repo, branch, sha);
  await client.putFile(repo, path, `# Marathon smoke\n\nGenerated ${new Date(stamp).toISOString()}\n`, branch, "docs: marathon smoke");

  console.log("[smoke-github-doc] open PR ...");
  const pr = await client.createPullRequest(repo, "[marathon] doc smoke", branch, "main", "Marathon M6 smoke. Safe to close.");
  console.log(`  opened PR #${pr.number} ${pr.url}`);

  console.log("[smoke-github-doc] comment ...");
  await client.commentIssue(repo, pr.number, "Marathon M6 document-surface smoke ✅");

  console.log("[smoke-github-doc] cleanup (close PR + delete branch) ...");
  await client.closePullRequest(repo, pr.number);
  await client.deleteRef(repo, branch);

  console.log("smoke-github-doc OK");
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (msg.includes("403") && /not accessible|Resource not accessible/i.test(msg)) {
    console.warn("smoke-github-doc SKIPPED: PAT needs Contents + Pull requests write.");
    process.exit(0);
  }
  console.error("smoke-github-doc FAILED:", err);
  process.exit(1);
});
