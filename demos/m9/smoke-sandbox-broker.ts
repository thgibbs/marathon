/**
 * LOCAL-ONLY e2e (Chunk D): a sandboxed process ↔ the host tool broker.
 * Requires Docker; skips gracefully if absent.
 *
 *   make smoke-broker
 *
 * Proves the §12.6 architecture end to end: a real container with **no network and
 * no credentials** does workspace FS work AND obtains governed-tool results solely by
 * asking the host broker over stdio — the host runs them through the ToolGateway
 * (creds + policy host-side) and returns redacted results; a destructive tool comes
 * back as requires_proposal. (The in-container agent is a stand-in for Pi-RPC.)
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvSecretStore } from "@marathon/config";
import { serveToolBroker, ToolGateway, ToolRegistry, Workspace, type Tool } from "@marathon/tools";

const agentPath = join(dirname(fileURLToPath(import.meta.url)), "sandbox-agent.cjs");

const lookupTool: Tool = {
  name: "host.lookup",
  description: "",
  riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false },
  defaultMode: "autonomous",
  async execute(input) {
    return { content: `host-side answer for ${String(input.q)}` };
  },
};
const deleteTool: Tool = {
  name: "host.delete",
  description: "",
  riskAxes: { reversible: false, crossesTrustBoundary: false, audience: "tenant", costly: false },
  defaultMode: "proposed_effect",
  async execute() {
    return { content: "deleted" };
  },
};

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"]);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("smoke-broker SKIPPED: Docker not available.");
    return;
  }

  const ws = await Workspace.create();
  await ws.writeFile("input.txt", "raw");

  const gateway = new ToolGateway({
    registry: new ToolRegistry([lookupTool, deleteTool]),
    policy: { grants: [{ tool: "host.lookup" }, { tool: "host.delete" }] },
    secrets: new EnvSecretStore({ HOST_ONLY_SECRET: "should-never-enter-sandbox" }),
  });

  const dockerArgs = [
    "run", "-i", "--rm",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=16m,exec",
    "--memory", "256m",
    "--pids-limit", "128",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-v", `${ws.dir}:/workspace:rw`,
    "-v", `${agentPath}:/agent.cjs:ro`,
    "-w", "/workspace",
    "node:22-alpine",
    "node", "/agent.cjs",
  ];

  console.log("[smoke-broker] launching sandboxed agent (no net, no creds) + host broker ...");
  const child = spawn("docker", dockerArgs);
  child.stderr.pipe(process.stderr);
  // Host serves brokered tool requests over the container's stdio.
  serveToolBroker(child.stdout, child.stdin, gateway, { taskId: "smoke", tenantId: "smoke" });

  const code: number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("container timed out")), 180_000);
    child.on("error", reject);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });
  if (code !== 0) throw new Error(`sandboxed agent exited ${code}`);

  const result = JSON.parse(await ws.readFile("output.txt"));
  const work = (await ws.readFile("work.txt")).trim();
  await ws.dispose();

  // assertions
  if (work !== "RAW") throw new Error(`workspace FS work failed: ${work}`);
  if (!result.workDone) throw new Error("agent did not do workspace work");
  if (result.lookupStatus !== "ok" || result.lookupContent !== "host-side answer for raw") {
    throw new Error(`brokered tool result wrong: ${JSON.stringify(result)}`);
  }
  if (result.destructiveStatus !== "requires_proposal") {
    throw new Error(`high-risk tool should require a proposal, got ${result.destructiveStatus}`);
  }

  console.log("[smoke-broker]   workspace FS work ✓ (RAW)");
  console.log("[smoke-broker]   governed tool brokered to host ✓ (no creds in sandbox)");
  console.log("[smoke-broker]   high-risk tool -> requires_proposal ✓");
  console.log("smoke-broker OK");
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon/i.test(msg)) {
    console.warn("smoke-broker SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("smoke-broker FAILED:", err);
  process.exit(1);
});
