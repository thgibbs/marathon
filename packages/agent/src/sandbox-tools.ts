import path from "node:path";
// Type-only imports (erased at runtime) keep Pi an optional dependency: this module
// loads with no Pi present, and the create*ToolDefinition factories are taken off the
// `pi` module object that pi.ts dynamically imports.
import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { DockerContainer } from "@marathon/tools";

/**
 * Sandbox tool routing (design §12.6, Pattern 2).
 *
 * Pi runs on the host (it calls the model + holds credentials); its file/shell tools
 * are re-implemented against a hardened {@link DockerContainer} so the *agent's* code
 * (`bash`) and file edits execute inside the sandbox — credential-free, with normal
 * outbound internet for package installs and doc lookups (Track 8: the boundary is
 * "no company secrets in the sandbox", not "no network") — against a bind-mounted
 * workspace at {@link GUEST_WORKSPACE}. Governed (credentialed) tools are NOT routed
 * here; they stay host-side behind the Tool Gateway.
 *
 * The container is the **execution** boundary; the workspace is the **data** boundary.
 * Every op resolves against the guest workspace path, so the container's filesystem
 * isolation (it cannot see the host fs except the workspace mount) is the security floor
 * even if a path is malformed.
 */
export const GUEST_WORKSPACE = "/workspace";

function decode(buf: Buffer): string {
  return buf.toString("utf8");
}

/** `read`/image ops backed by `cat`/`test` in the container. */
export function dockerReadOperations(container: DockerContainer): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const r = await container.execStream(["cat", "--", absolutePath], { timeoutMs: 10_000 });
      if (r.exitCode !== 0) throw new Error(`read failed (exit ${r.exitCode}): ${decode(r.stderr).trim()}`);
      return r.stdout;
    },
    access: async (absolutePath) => {
      const r = await container.execStream(["test", "-r", absolutePath], { timeoutMs: 5_000 });
      if (r.exitCode !== 0) throw new Error(`not readable in sandbox: ${absolutePath}`);
    },
    detectImageMimeType: async (absolutePath) => {
      const ext = path.posix.extname(absolutePath).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

/** `write` ops; content is piped via stdin to avoid argv size/quoting limits. */
export function dockerWriteOperations(container: DockerContainer): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      // sh -c 'cat > "$1"' sh <path>  →  $1 is the target, content arrives on stdin.
      const r = await container.execStream(["sh", "-c", 'cat > "$1"', "sh", absolutePath], {
        input: content,
        timeoutMs: 10_000,
      });
      if (r.exitCode !== 0) throw new Error(`write failed (exit ${r.exitCode}): ${decode(r.stderr).trim()}`);
    },
    mkdir: async (dir) => {
      const r = await container.execStream(["mkdir", "-p", "--", dir], { timeoutMs: 5_000 });
      if (r.exitCode !== 0) throw new Error(`mkdir failed (exit ${r.exitCode}): ${decode(r.stderr).trim()}`);
    },
  };
}

/** `edit` = read + write + access, composed from the above. */
export function dockerEditOperations(container: DockerContainer): EditOperations {
  const read = dockerReadOperations(container);
  const write = dockerWriteOperations(container);
  return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

/** `bash` ops: run the command via a shell inside the container at the guest cwd. */
export function dockerBashOperations(container: DockerContainer, shellPath = "/bin/sh"): BashOperations {
  return {
    // `env` is intentionally dropped: the sandbox is credential-free (§12.6).
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const r = await container.execStream([shellPath, "-lc", command], {
        cwd,
        onData,
        signal,
        timeoutMs: timeout && timeout > 0 ? timeout * 1000 : undefined,
      });
      return { exitCode: r.exitCode };
    },
  };
}

export interface DockerSandboxTools {
  /** Pi ToolDefinitions to add to `customTools`. */
  tools: unknown[];
  /** Tool names to add to the active-tools allowlist. */
  names: string[];
}

/**
 * Build the sandboxed `bash`/`read`/`write`/`edit` tool definitions, routed into
 * `container`. `pi` is the dynamically-imported `@earendil-works/pi-coding-agent`
 * module (kept loose to stay decoupled from Pi's internal types).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDockerSandboxTools(pi: any, container: DockerContainer, opts: { shellPath?: string } = {}): DockerSandboxTools {
  const ws = GUEST_WORKSPACE;
  const shellPath = opts.shellPath ?? "/bin/sh";
  const tools = [
    pi.createBashToolDefinition(ws, { operations: dockerBashOperations(container, shellPath) }),
    pi.createReadToolDefinition(ws, { operations: dockerReadOperations(container) }),
    pi.createWriteToolDefinition(ws, { operations: dockerWriteOperations(container) }),
    pi.createEditToolDefinition(ws, { operations: dockerEditOperations(container) }),
  ];
  return { tools, names: ["bash", "read", "write", "edit"] };
}
