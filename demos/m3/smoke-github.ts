/**
 * LOCAL-ONLY smoke for the REAL GitHub connector (NOT run in CI).
 *
 * Reads from a real repo via the PAT (secret/github -> GITHUB_TOKEN). Verifies
 * the HTTP client + tools end-to-end against GitHub.
 *
 *   make smoke-github            (defaults to thgibbs/agentp-demo)
 *   SMOKE_REPO=owner/name make smoke-github
 */
import { EnvSecretStore } from "@marathon/config";
import { httpGithubClientFactory, makeGithubReadTools } from "@marathon/connector-github";

async function main(): Promise<void> {
  const repo = process.env.SMOKE_REPO ?? "thgibbs/agentp-demo";
  const tools = makeGithubReadTools(httpGithubClientFactory());
  const readFile = tools.find((t) => t.name === "github.read_file")!;
  const listContents = tools.find((t) => t.name === "github.list_contents")!;
  const ctx = { taskId: "smoke", tenantId: "smoke", secrets: new EnvSecretStore() };

  console.log(`[smoke-github] listing ${repo} root ...`);
  const listing = await listContents.execute({ repo }, ctx);
  console.log(listing.content || "(empty)");

  // read the first file we can find (e.g. .gitignore)
  const entries = (listing.details?.entries as Array<{ type: string; path: string }>) ?? [];
  const firstFile = entries.find((e) => e.type === "file");
  if (firstFile) {
    console.log(`[smoke-github] reading ${firstFile.path} ...`);
    const file = await readFile.execute({ repo, path: firstFile.path }, ctx);
    console.log(`--- ${firstFile.path} (${file.content.length} bytes) ---`);
    console.log(file.content.slice(0, 400));
  }

  console.log("smoke-github OK");
}

main().catch((err) => {
  console.error("smoke-github FAILED:", err);
  process.exit(1);
});
