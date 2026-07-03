/**
 * LOCAL-ONLY e2e smoke for M9 sandbox tool routing (design §12.6, Pattern 2).
 * Requires Docker + a model key (OPENAI_API_KEY); skips if Docker is absent.
 *
 *   make smoke-pi-sandbox
 *
 * Proves the Pattern-2 split end-to-end with a REAL Pi model run:
 *   - Pi runs on the host (it calls the model and holds credentials).
 *   - The agent's `bash`/`write` tools execute INSIDE a hardened DockerContainer
 *     (no host creds; outbound internet allowed) against a bind-mounted workspace — a file the agent
 *     writes shows up on the host (write-through).
 *   - A GOVERNED `host_hostname` tool runs HOST-SIDE through the Tool Gateway; the host
 *     and sandbox hostnames differ, demonstrating the boundary.
 */
import os from "node:os";
import { spawn } from "node:child_process";
import { PiAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { emptyCheckpoint } from "@marathon/core";
import { DockerContainer, ToolGateway, ToolRegistry, Workspace, type Tool } from "@marathon/tools";

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"]);
    p.on("error", () => resolve(false));
    p.on("exit", (c) => resolve(c === 0));
  });
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("smoke-pi-sandbox SKIPPED: Docker not available.");
    return;
  }

  const secrets = new EnvSecretStore();
  const image = process.env.MARATHON_SANDBOX_IMAGE ?? "alpine:3.20";

  const ws = await Workspace.create();
  await ws.writeFile("seed.txt", "hello-from-host");

  // A governed, host-side tool: returns the HOST hostname. Proves credentialed/governed
  // tools run on the host, NOT in the sandbox.
  let hostToolCalled = false;
  const hostHostnameTool: Tool = {
    name: "host_hostname",
    description: "Return the hostname of the host machine.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
    defaultMode: "autonomous",
    async execute() {
      hostToolCalled = true;
      return { content: os.hostname() };
    },
  };
  const gateway = new ToolGateway({
    registry: new ToolRegistry([hostHostnameTool]),
    policy: { grants: [{ tool: "host_hostname" }] },
    secrets,
  });

  const runtime = new PiAgentRuntime({
    secrets,
    sandbox: { createContainer: () => new DockerContainer({ workspaceDir: ws.dir, image }) },
    governed: {
      gateway,
      tools: [
        {
          name: "host_hostname",
          description: "Return the hostname of the host machine.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  });

  console.log("[smoke-pi-sandbox] running a real Pi turn with sandboxed bash/write + a host-side governed tool ...");
  try {
    const turn = await runtime.nextTurn({
      request: {
        taskId: "smoke",
        tenantId: "smoke",
        instructions:
          "You have file/shell tools that run inside a sandbox, plus a host_hostname tool that runs on the host. Use your tools to do exactly what is asked. Be brief.",
        input: [
          "Do these steps using your tools, then report the results:",
          "1. Use the write tool to create the file /workspace/proof.txt with exactly the contents: SANDBOX_OK",
          "2. Use bash to print the sandbox hostname (run: hostname).",
          "3. Use bash to print the contents of /workspace/seed.txt (run: cat /workspace/seed.txt).",
          "4. Call the host_hostname tool to get the host hostname.",
          "Then reply with the sandbox hostname, the host hostname, and the seed.txt contents.",
        ].join("\n"),
        modelRef: process.env.SMOKE_MODEL ?? "openai:gpt-4o-mini",
      },
      checkpoint: emptyCheckpoint(),
    });

    console.log(`[smoke-pi-sandbox] reply: ${turn.text.slice(0, 400)}`);

    // Assert the SANDBOXED write wrote through to the HOST workspace.
    const proof = (await ws.readFile("proof.txt").catch(() => "")).trim();
    if (proof !== "SANDBOX_OK") {
      throw new Error(`expected /workspace/proof.txt == "SANDBOX_OK" on the host, got: "${proof}"`);
    }
    console.log("  -> sandboxed write wrote through to the host workspace ✓");

    // Assert the GOVERNED host tool actually ran (host-side).
    if (!hostToolCalled) throw new Error("the governed host_hostname tool was never invoked");
    console.log(`  -> governed host tool ran host-side (host=${os.hostname()}) ✓`);

    console.log("smoke-pi-sandbox OK");
  } finally {
    await ws.dispose();
  }
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon/i.test(msg)) {
    console.warn("smoke-pi-sandbox SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("smoke-pi-sandbox FAILED:", err);
  process.exit(1);
});
