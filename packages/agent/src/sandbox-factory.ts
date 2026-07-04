import type { AgentSandboxConfig } from "@marathon/config";
import { DockerContainer, type DockerContainerOptions } from "@marathon/tools";
import type { PiAgentOptions } from "./pi";
import type { AgentWorkspaceBinding } from "./types";

/**
 * BUILD-stage sandbox wiring (code-migration.md Track 11): the container is a
 * function of the task's *workspace state* — the host checkout the BUILD
 * runner materialized at `base_sha` — not ad hoc per-demo setup. Every call
 * gets a fresh hardened container (§11.2: containers are never recovered),
 * credential-free, with normal outbound internet (Track 8), mounted at
 * /workspace.
 */

/**
 * The pinned kernel toolchain image (`docker/sandbox/Dockerfile`; build with
 * `make sandbox-image`): git, gh, Node, pnpm, and common build tools — what an
 * LLM needs to drive a normal repo checkout. Deployments override via
 * `MARATHON_SANDBOX_IMAGE` or `image`.
 */
export const KERNEL_TOOLCHAIN_IMAGE = "marathon-sandbox:kernel";

export interface WorkspaceSandboxOptions {
  /** Toolchain image; default `MARATHON_SANDBOX_IMAGE` then {@link KERNEL_TOOLCHAIN_IMAGE}. */
  image?: string;
  /** Docker network; default `MARATHON_SANDBOX_NETWORK` then internet-enabled ("bridge"). */
  network?: string;
  /** Code tasks compile and test — default limits are sized for that. */
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  dockerPath?: string;
  /** Shell for the sandboxed bash tool (the toolchain image ships bash). */
  shellPath?: string;
}

/** Real code work (installs, builds, tests) needs more than the CLI-tool defaults. */
const DEFAULT_MEMORY = "2g";
const DEFAULT_CPUS = "2";
const DEFAULT_PIDS = 512;

/**
 * The container options for one task's workspace — pure, so tests can assert
 * the wiring (image pinning, workspace mount, no env/secrets) without Docker.
 */
export function workspaceContainerOptions(
  workspace: AgentWorkspaceBinding,
  opts: WorkspaceSandboxOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): DockerContainerOptions {
  return {
    workspaceDir: workspace.dir,
    image: opts.image ?? env.MARATHON_SANDBOX_IMAGE ?? KERNEL_TOOLCHAIN_IMAGE,
    network: opts.network ?? env.MARATHON_SANDBOX_NETWORK,
    memory: opts.memory ?? DEFAULT_MEMORY,
    cpus: opts.cpus ?? DEFAULT_CPUS,
    pidsLimit: opts.pidsLimit ?? DEFAULT_PIDS,
    dockerPath: opts.dockerPath,
  };
}

/**
 * Resolve the sandbox network for an agent spec (Track 15 closes Track 14's
 * "per-agent sandbox.network reaches BUILD wiring"). Strictness composes:
 * `"none"` from ANY source — explicit options, the deployment env, or the
 * agent YAML — wins, so no caller (including `makeBuildWiring`'s exposed
 * sandbox options) can relax a strict deployment or a strict agent. Among
 * non-strict values, precedence is options > env > spec.
 */
export function resolveSandboxNetwork(
  sandbox: AgentSandboxConfig,
  opts: WorkspaceSandboxOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envNetwork = env.MARATHON_SANDBOX_NETWORK;
  if (opts.network === "none" || envNetwork === "none" || sandbox.network === "none") return "none";
  return opts.network ?? envNetwork ?? sandbox.network;
}

/**
 * {@link workspaceSandbox}, with the network mode driven by the agent's YAML
 * `sandbox:` config (§6.2) — how a spec-configured BUILD runner should wire
 * its containers.
 */
export function workspaceSandboxFromSpec(
  spec: { sandbox: AgentSandboxConfig },
  opts: WorkspaceSandboxOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<PiAgentOptions["sandbox"]> {
  return workspaceSandbox({ ...opts, network: resolveSandboxNetwork(spec.sandbox, opts, env) }, env);
}

/**
 * The `PiAgentOptions.sandbox` config for BUILD tasks: a container per call,
 * bound to the workspace the worker provisioned (and registered in the
 * `CodeTaskRegistry` for the brokered `git.exec`/`delivery.report_pr` side).
 * Refuses to run without a workspace binding — a BUILD sandbox with no
 * workspace is a wiring bug, not a fallback.
 */
export function workspaceSandbox(opts: WorkspaceSandboxOptions = {}, env: NodeJS.ProcessEnv = process.env): NonNullable<PiAgentOptions["sandbox"]> {
  return {
    createContainer: (_req, workspace) => {
      if (!workspace) {
        throw new Error(
          "workspaceSandbox: no workspace binding for this task — BUILD containers are created from task workspace state (Track 11)",
        );
      }
      return new DockerContainer(workspaceContainerOptions(workspace, opts, env));
    },
    shellPath: opts.shellPath,
  };
}
