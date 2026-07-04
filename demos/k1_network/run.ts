/**
 * demo-k1-network (code-migration.md Track 17; Track 8 boundary): the BUILD
 * sandbox does real dependency/doc work over the open internet WITHOUT any
 * company secrets — the kernel's boundary is credential-freedom, not a closed
 * network.
 *
 *   make demo-k1-network        (requires Docker; skips gracefully without it)
 *
 * Proves, in a workspace-bound container built exactly the way the BUILD
 * runner builds them (workspaceSandbox / Track 11):
 *   1. a public fetch succeeds by default (docs lookups, package registries);
 *   2. host secrets planted in the process env are NOT visible inside;
 *   3. dependency work writes normal PR content into the workspace;
 *   4. the strict opt-in (`network: "none"`) actually blocks egress.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSandbox } from "@marathon/agent";
import type { DockerContainer } from "@marathon/tools";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const IMAGE = process.env.MARATHON_SANDBOX_IMAGE ?? "alpine:3.20";

async function main(): Promise<void> {
  // Plant fake "company secrets" in the demo's own env: if any container can
  // see these, the credential-freedom boundary is broken.
  process.env.GITHUB_TOKEN = "ghp_demo_fake_token_do_not_leak";
  process.env.OPENAI_API_KEY = "sk-demo-fake-key";

  const ws = await mkdtemp(join(tmpdir(), "marathon-k1-network-ws-"));
  const binding = { dir: ws, baseSha: "0000000" };
  const request = { taskId: "k1-network", instructions: "", input: "", modelRef: "fake:none" };

  // The container comes from the BUILD-stage factory (Track 11): hardened,
  // workspace-mounted, internet-enabled bridge network by default.
  const sandbox = workspaceSandbox({ image: IMAGE }, { MARATHON_SANDBOX_IMAGE: IMAGE });
  const container = (await sandbox.createContainer(request, binding)) as DockerContainer;
  await container.start();
  try {
    // 1. public docs/package fetch works by default (exec throws on failure).
    await container.exec("wget", ["-q", "-T", "10", "-O", "/workspace/example.html", "https://example.com"], {
      timeoutMs: 60_000,
    });
    console.log("[k1-network] public doc fetched from inside the sandbox ✓");

    // 2. no company secrets inside the container.
    const env = await container.exec("printenv", [], { timeoutMs: 30_000 });
    assert(
      !/ghp_demo_fake_token|sk-demo-fake-key|GITHUB_TOKEN|OPENAI_API_KEY|SLACK_/.test(env.stdout),
      "host secrets leaked into the sandbox!",
    );
    console.log("[k1-network] no host secrets in the container env ✓");

    // 3. dependency work lands as normal PR content in the workspace: the
    // fetched file is on the host side of the mount, ready for git.
    const html = await readFile(join(ws, "example.html"), "utf8");
    assert(html.toLowerCase().includes("example"), "fetched content should land in the workspace");
    console.log("[k1-network] fetched content landed in the task workspace (normal PR content) ✓");
  } finally {
    await container.stop().catch(() => {});
  }

  // 4. the strict opt-in blocks egress (per-agent `sandbox.network: none`,
  // or MARATHON_SANDBOX_NETWORK=none for the deployment).
  const strictSandbox = workspaceSandbox({ image: IMAGE, network: "none" }, { MARATHON_SANDBOX_IMAGE: IMAGE });
  const strict = (await strictSandbox.createContainer(request, binding)) as DockerContainer;
  await strict.start();
  try {
    const blocked = await strict
      .exec("wget", ["-q", "-T", "3", "-O", "-", "https://example.com"], { timeoutMs: 30_000 })
      .then(() => false)
      .catch(() => true);
    assert(blocked, "strict mode (network: none) should block egress");
    console.log("[k1-network] strict opt-in (network: none) blocks egress ✓");
  } finally {
    await strict.stop().catch(() => {});
    await rm(ws, { recursive: true, force: true });
  }

  console.log("demo-k1-network OK");
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon|command not found/i.test(msg)) {
    console.warn("demo-k1-network SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("demo-k1-network FAILED:", err);
  process.exit(1);
});
