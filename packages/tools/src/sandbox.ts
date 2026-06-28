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
 * trusted local/dev use; production should use a Docker/Gondolin sandbox (staged).
 */
export class LocalSubprocessSandbox implements ToolSandbox {
  readonly name = "local-subprocess";
  async run(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxResult> {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: opts?.timeoutMs ?? 5000, maxBuffer: 1024 * 1024 });
    return { stdout, stderr };
  }
}
