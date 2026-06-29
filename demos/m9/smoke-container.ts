/**
 * LOCAL-ONLY smoke for the persistent DockerContainer (design §12.6, Pattern 2).
 * Requires Docker; skips if absent.
 *
 *   make smoke-container
 *
 * Verifies the lifecycle the tool-routing extension will drive: start a long-lived
 * hardened container with a mounted workspace, exec several commands into it
 * (including a WRITE that must write through to the host), then stop it.
 */
import { spawn } from "node:child_process";
import { DockerContainer, Workspace } from "@marathon/tools";

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"]);
    p.on("error", () => resolve(false));
    p.on("exit", (c) => resolve(c === 0));
  });
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("smoke-container SKIPPED: Docker not available.");
    return;
  }

  const ws = await Workspace.create();
  await ws.writeFile("input.txt", "from-host");
  const c = new DockerContainer({ workspaceDir: ws.dir, image: process.env.MARATHON_SANDBOX_IMAGE ?? "alpine:3.20" });

  try {
    console.log("[smoke-container] start ...");
    await c.start();

    // read a host-written file
    const read = await c.exec("cat", ["/workspace/input.txt"], { timeoutMs: 30_000 });
    if (read.stdout.trim() !== "from-host") throw new Error(`read failed: ${read.stdout}`);
    console.log("  -> exec read host file ✓");

    // write from the container -> must write through to the host
    await c.exec("sh", ["-c", "echo from-sandbox > /workspace/output.txt"], { timeoutMs: 30_000 });
    const hostSees = (await ws.readFile("output.txt")).trim();
    if (hostSees !== "from-sandbox") throw new Error(`write-through failed; host saw: ${hostSees}`);
    console.log("  -> exec write wrote through to the host workspace ✓");

    // reuse the SAME container for another exec (persistence)
    const ls = await c.exec("ls", ["/workspace"], { timeoutMs: 30_000 });
    if (!ls.stdout.includes("output.txt")) throw new Error(`persistent exec failed: ${ls.stdout}`);
    console.log("  -> same container reused across execs ✓");

    console.log("smoke-container OK");
  } finally {
    await c.stop();
    await ws.dispose();
  }
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon/i.test(msg)) {
    console.warn("smoke-container SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("smoke-container FAILED:", err);
  process.exit(1);
});
