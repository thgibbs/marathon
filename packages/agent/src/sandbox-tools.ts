import path from "node:path";
// Type-only imports (erased at runtime) keep Pi an optional dependency: this module
// loads with no Pi present, and the create*ToolDefinition factories are taken off the
// `pi` module object that pi.ts dynamically imports.
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
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

/** `ls` ops backed by one listing exec per directory (§2b #2). */
export function dockerLsOperations(container: DockerContainer): LsOperations {
  // Pi's ls tool stats EVERY entry it lists; a naive per-entry `test -d`
  // would cost one docker-exec round-trip per file. Fetch each directory in
  // ONE exec (names, with a trailing "/" marking directories) and serve the
  // per-entry stats from that cache.
  const listings = new Map<string, Map<string, boolean>>();
  const list = async (dir: string): Promise<Map<string, boolean>> => {
    const cached = listings.get(dir);
    if (cached) return cached;
    const r = await container.execStream(
      [
        "sh",
        "-c",
        'cd -- "$1" || exit 2; ls -1A | while IFS= read -r f; do if [ -d "$f" ]; then printf "%s/\\n" "$f"; else printf "%s\\n" "$f"; fi; done',
        "sh",
        dir,
      ],
      { timeoutMs: 10_000 },
    );
    if (r.exitCode !== 0) throw new Error(`ls failed (exit ${r.exitCode}): ${decode(r.stderr).trim()}`);
    const entries = new Map<string, boolean>();
    for (const line of decode(r.stdout).split("\n")) {
      if (!line) continue;
      const isDir = line.endsWith("/");
      entries.set(isDir ? line.slice(0, -1) : line, isDir);
    }
    listings.set(dir, entries);
    return entries;
  };
  return {
    exists: async (absolutePath) =>
      (await container.execStream(["test", "-e", absolutePath], { timeoutMs: 5_000 })).exitCode === 0,
    stat: async (absolutePath) => {
      const fromListing = listings.get(path.posix.dirname(absolutePath))?.get(path.posix.basename(absolutePath));
      if (fromListing !== undefined) return { isDirectory: () => fromListing };
      const r = await container.execStream(
        ["sh", "-c", 'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else exit 2; fi', "sh", absolutePath],
        { timeoutMs: 5_000 },
      );
      if (r.exitCode !== 0) throw new Error(`not found in sandbox: ${absolutePath}`);
      const isDir = decode(r.stdout).trim() === "d";
      return { isDirectory: () => isDir };
    },
    readdir: async (absolutePath) => [...(await list(absolutePath)).keys()],
  };
}

/**
 * `find` ops: the glob runs as `rg --files --glob` INSIDE the container (the
 * toolchain image ships ripgrep). Returns absolute guest paths so Pi's
 * relativize step (`p.startsWith(searchPath)`) works — a relative return
 * would be resolved against the HOST cwd.
 */
export function dockerFindOperations(container: DockerContainer): FindOperations {
  return {
    exists: async (absolutePath) =>
      (await container.execStream(["test", "-e", absolutePath], { timeoutMs: 5_000 })).exitCode === 0,
    glob: async (pattern, cwd, { ignore, limit }) => {
      const argv = ["rg", "--files", "--hidden", "--glob", pattern];
      for (const ig of ignore) argv.push("--glob", `!${ig}`);
      const r = await container.execStream(argv, { cwd, timeoutMs: 30_000 });
      // rg exits 1 when nothing matched — that's an empty result, not an error.
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        throw new Error(`find failed (exit ${r.exitCode}): ${decode(r.stderr).trim() || "is ripgrep in the sandbox image?"}`);
      }
      return decode(r.stdout)
        .split("\n")
        .filter((l) => l.length > 0)
        .slice(0, limit)
        .map((l) => path.posix.join(cwd, l));
    },
  };
}

/** Match lines look like `path:12:text`; context lines use `-` separators. */
const GREP_MATCH_LINE = /^.+?:\d+:/;
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_BYTES = 64 * 1024;

/**
 * A sandboxed `grep` tool. Pi's own grep factory cannot be routed with
 * operations alone — it ALWAYS spawns ripgrep on the host against the search
 * path (the custom operations only serve `isDirectory` + context-line reads),
 * which would search the host filesystem. So the whole search runs as `rg`
 * inside the container instead. Exported for tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSandboxGrepTool(pi: any, container: DockerContainer, ws: string): unknown {
  return pi.defineTool({
    name: "grep",
    label: "grep",
    description:
      "Search file contents in the workspace for a pattern (regex by default). " +
      "Returns matching lines as path:line: text. Respects .gitignore. " +
      `Output is truncated to ${GREP_DEFAULT_LIMIT} matches (override with limit) or ${GREP_MAX_BYTES / 1024}KB.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search (default: workspace root)" },
        glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
        literal: { type: "boolean", description: "Treat pattern as a literal string instead of a regex" },
        context: { type: "number", description: "Lines of context before/after each match (default: 0)" },
        limit: { type: "number", description: `Maximum matches to return (default: ${GREP_DEFAULT_LIMIT})` },
      },
      required: ["pattern"],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: any) => {
      const pattern = String(params?.pattern ?? "");
      const searchDir = typeof params?.path === "string" && params.path ? params.path : ".";
      const target = path.posix.isAbsolute(searchDir) ? searchDir : path.posix.join(ws, searchDir);
      const limit = typeof params?.limit === "number" && params.limit > 0 ? params.limit : GREP_DEFAULT_LIMIT;
      const argv = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden"];
      if (params?.ignoreCase) argv.push("--ignore-case");
      if (params?.literal) argv.push("--fixed-strings");
      if (typeof params?.glob === "string" && params.glob) argv.push("--glob", params.glob);
      if (typeof params?.context === "number" && params.context > 0) argv.push("--context", String(params.context));
      argv.push("--", pattern, target);
      const r = await container.execStream(argv, { timeoutMs: 30_000 });
      if (r.exitCode === 1) return { content: [{ type: "text", text: "No matches found" }], details: {} };
      if (r.exitCode !== 0) {
        throw new Error(`grep failed (exit ${r.exitCode}): ${decode(r.stderr).trim() || "is ripgrep in the sandbox image?"}`);
      }
      // Truncate by match count (context lines ride along with their match)
      // and byte size, whichever bites first.
      const out: string[] = [];
      let matches = 0;
      let bytes = 0;
      let truncated = false;
      for (const line of decode(r.stdout).split("\n")) {
        if (GREP_MATCH_LINE.test(line)) {
          if (matches >= limit) {
            truncated = true;
            break;
          }
          matches++;
        }
        bytes += line.length + 1;
        if (bytes > GREP_MAX_BYTES) {
          truncated = true;
          break;
        }
        out.push(line);
      }
      let text = out.join("\n").trimEnd() || "No matches found";
      if (truncated) text += `\n\n[Truncated: ${limit} matches or ${GREP_MAX_BYTES / 1024}KB limit]`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

export interface DockerSandboxTools {
  /** Pi ToolDefinitions to add to `customTools`. */
  tools: unknown[];
  /** Tool names to add to the active-tools allowlist. */
  names: string[];
}

/**
 * Build the sandboxed `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` tool
 * definitions, all routed into `container` (§2b #2 — no built-in escapes to
 * the host filesystem). `pi` is the dynamically-imported
 * `@earendil-works/pi-coding-agent` module (kept loose to stay decoupled from
 * Pi's internal types).
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
    // grep is a custom in-container tool: Pi's factory always spawns ripgrep
    // on the HOST, so routing it via operations alone would search the wrong
    // filesystem. find/ls are fully pluggable and use Pi's factories.
    buildSandboxGrepTool(pi, container, ws),
    pi.createFindToolDefinition(ws, { operations: dockerFindOperations(container) }),
    pi.createLsToolDefinition(ws, { operations: dockerLsOperations(container) }),
  ];
  return { tools, names: ["bash", "read", "write", "edit", "grep", "find", "ls"] };
}
