/**
 * LOCAL-ONLY smoke for the Docker ToolSandbox (design §12.6). Requires Docker.
 * Skips gracefully if Docker isn't available.
 *
 *   make smoke-sandbox
 *
 * Verifies a command runs in an ephemeral, network-denied, credential-free
 * container — and that egress is actually blocked.
 */
import { DockerSandbox } from "@marathon/tools";

async function main(): Promise<void> {
  const sandbox = new DockerSandbox({ image: process.env.MARATHON_SANDBOX_IMAGE ?? "alpine:3.20" });

  // 1. a command runs and returns output
  console.log("[smoke-sandbox] running `echo` in a hardened container ...");
  const echo = await sandbox.run("echo", ["sandboxed-ok"], { timeoutMs: 30_000 });
  if (echo.stdout.trim() !== "sandboxed-ok") throw new Error(`unexpected output: ${echo.stdout}`);
  console.log("  -> output:", echo.stdout.trim());

  // 2. the sandbox is credential-free: host env is not visible inside
  const env = await sandbox.run("printenv", [], { timeoutMs: 30_000 }).catch((e) => ({ stdout: String(e), stderr: "" }));
  if (/GITHUB_TOKEN|OPENAI_API_KEY|SLACK_/.test(env.stdout)) throw new Error("host secrets leaked into the sandbox!");
  console.log("  -> no host secrets in container env ✓");

  // 3. network egress is denied (`--network none`) — this command should FAIL
  const net = await sandbox
    .run("wget", ["-q", "-T", "3", "-O", "-", "https://example.com"], { timeoutMs: 30_000 })
    .then(() => ({ blocked: false }))
    .catch(() => ({ blocked: true }));
  if (!net.blocked) throw new Error("network egress was NOT blocked");
  console.log("  -> network egress blocked ✓");

  console.log("smoke-sandbox OK");
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon|command not found/i.test(msg)) {
    console.warn("smoke-sandbox SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("smoke-sandbox FAILED:", err);
  process.exit(1);
});
