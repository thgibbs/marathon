/**
 * Local, faithful copies of Pi's pluggable tool-operation interfaces
 * (`@earendil-works/pi-coding-agent`, v0.80.2 `core/tools/*`).
 *
 * Why re-declare them instead of `import type … from "@earendil-works/pi-coding-agent"`:
 * that private package is loaded ONLY through a runtime (non-literal) dynamic
 * import — see `pi.ts` `PI_MODULE` — so the Pi harness stays optional. A static
 * `import type` from it, though erased at runtime, still forces `tsc` to resolve
 * the package at compile time, which means `pnpm typecheck` (and the test suite)
 * can't run in an environment without the private-registry credentials to
 * install it — e.g. Marathon's own credential-free build sandbox (§12.6), which
 * then can't self-verify green and leaves PRs stuck as drafts (§29.3).
 *
 * These interfaces only reference Node built-ins, so the copy is self-contained.
 * They describe the shape `docker*Operations` (in `sandbox-tools.ts`) must
 * satisfy; the actual `pi.create*ToolDefinition` factories receive them through
 * the dynamically-imported (and therefore `any`-typed) `pi` module, so nothing
 * type-checks these against Pi's real types at the call site anyway. If Pi's
 * operation contracts change in a future bump, update these to match.
 */

/** Pluggable operations for Pi's `read` tool. */
export interface ReadOperations {
  /** Read file contents as a Buffer. */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if a file is readable (throw if not). */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type; return null/undefined for non-images. */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

/** Pluggable operations for Pi's `write` tool. */
export interface WriteOperations {
  /** Write content to a file. */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Create a directory recursively. */
  mkdir: (dir: string) => Promise<void>;
}

/** Pluggable operations for Pi's `edit` tool. */
export interface EditOperations {
  /** Read file contents as a Buffer. */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file. */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if a file is readable and writable (throw if not). */
  access: (absolutePath: string) => Promise<void>;
}

/** Pluggable operations for Pi's `bash` tool. */
export interface BashOperations {
  /**
   * Execute a command and stream output.
   * @returns the exit code (null if killed).
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/** Pluggable operations for Pi's `ls` tool. */
export interface LsOperations {
  /** Check if a path exists. */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Get file or directory stats; throws if not found. */
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries. */
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

/** Pluggable operations for Pi's `find` tool. */
export interface FindOperations {
  /** Check if a path exists. */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Find files matching a glob pattern; returns relative or absolute paths. */
  glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}
