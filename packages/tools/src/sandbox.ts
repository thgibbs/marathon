import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SandboxResult {
  stdout: string;
  stderr: string;
}

/**
 * Execution backend for shell/CLI tools (design §12.6). Pi has no sandbox, so
 * Marathon must choose one explicitly. The default is {@link NoSandbox}, which
 * refuses — there is no implicit unsandboxed shell.
 */
export interface ToolSandbox {
  readonly name: string;
  run(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxResult>;
}

/** Default: refuses to run any command. No sandbox configured ⇒ no shell. */
export class NoSandbox implements ToolSandbox {
  readonly name = "none";
  async run(): Promise<SandboxResult> {
    throw new Error("shell execution requires a sandbox; none is configured (design §12.6). Provide a ToolSandbox to enable CLI tools.");
  }
}

/**
 * Runs allowlisted binaries directly on the host. **Not isolated** — only for
 * trusted local/dev use; production should use {@link DockerSandbox}.
 */
export class LocalSubprocessSandbox implements ToolSandbox {
  readonly name = "local-subprocess";
  async run(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxResult> {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: opts?.timeoutMs ?? 5000, maxBuffer: 1024 * 1024 });
    return { stdout, stderr };
  }
}

export interface DockerSandboxOptions {
  /** Base image; must contain the allowlisted binaries (default a small Linux image). */
  image?: string;
  memory?: string; // e.g. "256m"
  cpus?: string; // e.g. "1"
  pidsLimit?: number; // anti fork-bomb
  /** "none" (default) denies all egress; a network name enables an allowlisted one. */
  network?: string;
  /** Host dir mounted read-write at /workspace; otherwise only a tmpfs scratch. */
  workspaceDir?: string;
  user?: string; // non-root, e.g. "1000:1000"
  dockerPath?: string; // default "docker"
}

/**
 * Build the hardened `docker run` argv (design §12.6). Pure + exported so the
 * isolation flags can be asserted in CI without a Docker daemon.
 *
 * Hardening: ephemeral (`--rm`), **no network**, read-only rootfs + tmpfs scratch,
 * all capabilities dropped, `no-new-privileges`, non-root user, CPU/memory/pids
 * limits, and **no env/secrets passed in** (the sandbox is credential-free).
 */
export function dockerRunArgs(image: string, bin: string, args: string[], opts: DockerSandboxOptions = {}): string[] {
  const a = [
    "run",
    "--rm",
    "--network",
    opts.network ?? "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=64m,exec",
    "--memory",
    opts.memory ?? "256m",
    "--cpus",
    opts.cpus ?? "1",
    "--pids-limit",
    String(opts.pidsLimit ?? 128),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    opts.user ?? "1000:1000",
  ];
  if (opts.workspaceDir) a.push("-v", `${opts.workspaceDir}:/workspace:rw`, "-w", "/workspace");
  else a.push("-w", "/tmp");
  a.push(image, bin, ...args);
  return a;
}

/**
 * Runs each command in an ephemeral, isolated Docker container (design §12.6).
 * One container per command (`--rm`); a persistent-workspace lifecycle is a
 * follow-on. Fails closed: if Docker is unavailable or the run errors, `run`
 * throws and the gateway denies the tool call.
 */
export class DockerSandbox implements ToolSandbox {
  readonly name = "docker";
  constructor(private readonly opts: DockerSandboxOptions = {}) {}

  async run(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxResult> {
    const image = this.opts.image ?? "alpine:3.20";
    const argv = dockerRunArgs(image, bin, args, this.opts);
    const { stdout, stderr } = await execFileAsync(this.opts.dockerPath ?? "docker", argv, {
      timeout: opts?.timeoutMs ?? 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr };
  }
}

/**
 * Pick the sandbox backend from config (design §12.6: deployment chooses). Default
 * `none` (fail closed — no shell). `MARATHON_SANDBOX` = `none` | `local` | `docker`.
 */
export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): ToolSandbox {
  switch ((env.MARATHON_SANDBOX ?? "none").toLowerCase()) {
    case "docker":
      return new DockerSandbox({ image: env.MARATHON_SANDBOX_IMAGE });
    case "local":
      return new LocalSubprocessSandbox();
    default:
      return new NoSandbox();
  }
}
