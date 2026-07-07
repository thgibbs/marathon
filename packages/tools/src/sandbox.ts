import { execFile, spawn } from "node:child_process";
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
  /**
   * Docker network. Default "bridge": normal outbound internet — the kernel
   * sandbox needs package installs, docs, and framework CLIs (Track 8; the
   * boundary is "no company secrets in the sandbox", not "no network").
   * Set "none" for a strict, egress-denied sandbox.
   */
  network?: string;
  /** Host dir mounted read-write at /workspace; otherwise only a tmpfs scratch. */
  workspaceDir?: string;
  user?: string; // non-root, e.g. "1000:1000"
  dockerPath?: string; // default "docker"
}

/**
 * The shared isolation flags (design §12.6, corrected by Track 8): read-only
 * rootfs + tmpfs scratch, all capabilities dropped, `no-new-privileges`,
 * non-root user, CPU/memory/pids limits — and **no env/secrets** (the sandbox
 * is credential-free; that, not the network, is the security boundary).
 * Outbound internet is ON by default so normal dependency/doc work succeeds;
 * pass `network: "none"` for a strict sandbox. Used by both the one-shot
 * `docker run` and the persistent container.
 */
export function hardeningFlags(opts: DockerSandboxOptions = {}): string[] {
  return [
    "--network",
    opts.network ?? "bridge",
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
}

/**
 * Build the hardened one-shot `docker run` argv. Pure + exported so the isolation
 * flags can be asserted in CI without a Docker daemon.
 */
export function dockerRunArgs(image: string, bin: string, args: string[], opts: DockerSandboxOptions = {}): string[] {
  const a = ["run", "--rm", ...hardeningFlags(opts)];
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

export interface ContainerMount {
  /** Host path. */
  source: string;
  /** Path inside the container. */
  target: string;
  readonly?: boolean;
}

export interface DockerContainerOptions extends DockerSandboxOptions {
  /** Host dir mounted at /workspace (required). Read-write unless `readonlyWorkspace`. */
  workspaceDir: string;
  /**
   * Mount the workspace **read-only** (chat-repo.md §3.4): the agent can read
   * the checkout but not mutate it, even via a shell. The harness's own
   * scratch/session under `.marathon-home` is layered back as a writable mount
   * so it can still be written. Used for chat-surface repo grounding.
   */
  readonlyWorkspace?: boolean;
  /**
   * Extra bind mounts beyond the workspace (K7: the per-task broker unix socket,
   * `claude-code-impl.md` §3.1). These carry no secrets — the socket is the
   * governed-tool boundary, brokered host-side.
   */
  mounts?: ContainerMount[];
  /**
   * `--add-host` entries (e.g. `host.docker.internal:host-gateway`) so the
   * container can reach a host-side TCP broker on Linux Docker (§3.1). Auto on
   * Docker Desktop, but harmless there.
   */
  extraHosts?: string[];
  /** Owner label for orphan reaping (see {@link SANDBOX_OWNER_LABEL}). */
  sandboxOwner?: string;
}

/** The sandbox HOME dir name inside the workspace mount (Track 11). */
export const GUEST_HOME_DIRNAME = ".marathon-home";

/**
 * Docker label stamped on every persistent Marathon sandbox container so orphans
 * (left behind when the host process is killed mid-task, before `stop()` runs)
 * can be found and reaped. See {@link reapSandboxContainers}.
 */
export const SANDBOX_LABEL = "marathon.sandbox";

/**
 * Owner label: identifies WHICH deployment/role owns a container (e.g.
 * `marathon-github-app`). The boot reaper scopes to its own owner so one
 * Marathon process never kills a peer process's in-flight container.
 */
export const SANDBOX_OWNER_LABEL = "marathon.sandbox.owner";

/** Build the persistent-container `docker run -d` argv (pure; CI-testable). */
export function dockerStartArgs(image: string, opts: DockerContainerOptions): string[] {
  const mounts = (opts.mounts ?? []).flatMap((m) => ["-v", `${m.source}:${m.target}${m.readonly ? ":ro" : ""}`]);
  const addHosts = (opts.extraHosts ?? []).flatMap((h) => ["--add-host", h]);
  const workspaceMounts = opts.readonlyWorkspace
    ? [
        // The repo checkout is read-only; the harness home is layered back as a
        // writable mount over the read-only workspace (Docker honors the inner,
        // more-specific mount) so the session/config/caches can still be written.
        "-v",
        `${opts.workspaceDir}:/workspace:ro`,
        "-v",
        `${opts.workspaceDir}/${GUEST_HOME_DIRNAME}:/workspace/${GUEST_HOME_DIRNAME}:rw`,
      ]
    : ["-v", `${opts.workspaceDir}:/workspace:rw`];
  return [
    "run",
    "-d",
    "--rm",
    // Identify Marathon sandbox containers so orphans can be reaped (a keep-alive
    // container leaks if the host process dies before `stop()` runs), and stamp
    // the OWNER so the reaper only touches its own deployment's containers.
    "--label",
    `${SANDBOX_LABEL}=1`,
    ...(opts.sandboxOwner ? ["--label", `${SANDBOX_OWNER_LABEL}=${opts.sandboxOwner}`] : []),
    ...hardeningFlags(opts),
    ...addHosts,
    ...workspaceMounts,
    ...mounts,
    "-w",
    "/workspace",
    image,
    "tail",
    "-f",
    "/dev/null", // keep-alive; we exec commands into it
  ];
}

/**
 * Reap orphaned Marathon sandbox containers at live-app startup. Task containers
 * are created on demand DURING processing, never at boot, so anything labeled
 * and lingering when a fresh process starts is a leak from a PREVIOUS run of the
 * same deployment (e.g. the dev server was SIGKILL'd mid-task — a clean SIGINT
 * is handled by {@link installSandboxShutdownHandler} instead).
 *
 * `owner` scopes the reap to a single deployment/role: a github-app boot passes
 * its own owner and thus never removes a concurrently-running slack-app's
 * in-flight container. Reaping ALL Marathon containers (no owner) is left as an
 * explicit, opt-in local-dev convenience — not what the apps do. Returns the
 * ids removed. Best-effort — an absent/erroring Docker must not block boot.
 */
/** The `docker ps --filter` value the reaper uses: owner-scoped, or global if unset. */
export function sandboxReapFilter(owner?: string): string {
  return owner ? `label=${SANDBOX_OWNER_LABEL}=${owner}` : `label=${SANDBOX_LABEL}`;
}

export async function reapSandboxContainers(opts: { owner?: string; dockerPath?: string } = {}): Promise<string[]> {
  const dockerPath = opts.dockerPath ?? "docker";
  const filter = sandboxReapFilter(opts.owner);
  try {
    const { stdout } = await execFileAsync(dockerPath, ["ps", "-aq", "--filter", filter], { timeout: 10_000 });
    const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return [];
    await execFileAsync(dockerPath, ["rm", "-f", ...ids], { timeout: 30_000 }).catch(() => {});
    return ids;
  } catch {
    return [];
  }
}

/**
 * A long-lived hardened container for **tool routing** (design §12.6, Pattern 2): the
 * agent's built-in tools (read/write/bash/…) `exec` into it against the mounted
 * workspace, while Pi + model + credentials stay on the host. Lifecycle: `start()`
 * once per session → `exec()` per tool op → `stop()`.
 */
export class DockerContainer {
  readonly name = "docker-container";
  private containerId?: string;
  constructor(private readonly opts: DockerContainerOptions) {}

  private docker(): string {
    return this.opts.dockerPath ?? "docker";
  }

  async start(): Promise<void> {
    if (this.containerId) return;
    const image = this.opts.image ?? "alpine:3.20";
    const { stdout } = await execFileAsync(this.docker(), dockerStartArgs(image, this.opts), { timeout: 60_000 });
    this.containerId = stdout.trim();
    // Track for graceful shutdown: a signal handler stops these before exit so
    // Ctrl-C mid-task doesn't leak a keep-alive container (see stopAllSandboxContainers).
    ACTIVE_CONTAINERS.add(this);
  }

  async exec(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxResult> {
    if (!this.containerId) throw new Error("DockerContainer.exec: container not started");
    const { stdout, stderr } = await execFileAsync(this.docker(), ["exec", this.containerId, bin, ...args], {
      timeout: opts?.timeoutMs ?? 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr };
  }

  /**
   * Lower-level exec used for tool routing (design §12.6, Pattern 2): streams output,
   * supports stdin (`write`), a working directory, abort, and timeout, and **returns the
   * exit code instead of throwing** on non-zero (a shell tool legitimately exits non-zero).
   * No host env is forwarded — the sandbox is credential-free by construction. `opts.env`
   * passes an *explicit* set of NON-secret variables into the exec (e.g. the Claude Code
   * harness's `ANTHROPIC_BASE_URL` proxy pointer and placeholder key, §4.1) — the caller is
   * responsible for never putting a credential here.
   */
  async execStream(
    argv: string[],
    opts: {
      onData?: (chunk: Buffer) => void;
      input?: string | Buffer;
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
    if (!this.containerId) throw new Error("DockerContainer.execStream: container not started");
    const envArgs = opts.env ? Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
    const dockerArgs = [
      "exec",
      ...(opts.input !== undefined ? ["-i"] : []),
      ...(opts.cwd ? ["-w", opts.cwd] : []),
      ...envArgs,
      this.containerId,
      ...argv,
    ];
    return await new Promise((resolve, reject) => {
      const child = spawn(this.docker(), dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeoutMs)
          : undefined;
      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.on("data", (d: Buffer) => {
        out.push(d);
        opts.onData?.(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        err.push(d);
        opts.onData?.(d);
      });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (timedOut) return reject(new Error(`docker exec timed out after ${opts.timeoutMs}ms`));
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        resolve({ exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      });
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    });
  }

  async stop(): Promise<void> {
    ACTIVE_CONTAINERS.delete(this);
    if (!this.containerId) return;
    const id = this.containerId;
    this.containerId = undefined;
    await execFileAsync(this.docker(), ["rm", "-f", id], { timeout: 30_000 }).catch(() => {});
  }
}

/** Containers this process started and hasn't stopped — the graceful-shutdown set. */
const ACTIVE_CONTAINERS = new Set<DockerContainer>();

/**
 * Stop every sandbox container this process started (graceful shutdown). Called
 * from a SIGINT/SIGTERM handler so Ctrl-C during a task tears the container down
 * cleanly instead of leaking it — the precise, concurrency-safe complement to
 * the boot-time {@link reapSandboxContainers} backstop (which covers SIGKILL /
 * crashes, where no handler runs). Returns how many were stopped.
 */
export async function stopAllSandboxContainers(): Promise<number> {
  const containers = [...ACTIVE_CONTAINERS];
  await Promise.all(containers.map((c) => c.stop().catch(() => {})));
  return containers.length;
}

/**
 * Install a one-shot SIGINT/SIGTERM handler that stops this process's sandbox
 * containers, then exits. Idempotent; returns a disposer that removes it.
 */
export function installSandboxShutdownHandler(onStopped?: (count: number, signal: string) => void): () => void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopAllSandboxContainers().then((count) => {
      onStopped?.(count, signal);
      // 128 + signal number is the conventional exit code for a signal.
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const onInt = () => handle("SIGINT");
  const onTerm = () => handle("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

/**
 * Pick the sandbox backend from config (design §12.6: deployment chooses). Default
 * `none` (fail closed — no shell). `MARATHON_SANDBOX` = `none` | `local` | `docker`;
 * `MARATHON_SANDBOX_NETWORK` overrides the Docker network (e.g. `none` for strict).
 */
export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): ToolSandbox {
  switch ((env.MARATHON_SANDBOX ?? "none").toLowerCase()) {
    case "docker":
      return new DockerSandbox({ image: env.MARATHON_SANDBOX_IMAGE, network: env.MARATHON_SANDBOX_NETWORK });
    case "local":
      return new LocalSubprocessSandbox();
    default:
      return new NoSandbox();
  }
}
