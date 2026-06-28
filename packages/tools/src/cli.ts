import type { Tool, ToolInput } from "./types";
import { NoSandbox, type ToolSandbox } from "./sandbox";

/**
 * A command-line tool — Marathon's primary tool type (design.md §14.5). Commands
 * are restricted to an allowlist of binaries AND executed through a {@link ToolSandbox}.
 * The default sandbox ({@link NoSandbox}) refuses, so there is **no implicit
 * unsandboxed shell** — callers must opt into an execution backend (design.md §12.6).
 */
export function makeCliTool(allowlist: string[], sandbox: ToolSandbox = new NoSandbox()): Tool {
  return {
    name: "cli.run",
    description: "Run an allowlisted command-line program (in a sandbox).",
    riskLevel: "medium",
    destructive: false,
    validate(input: ToolInput): string | null {
      const command = input.command;
      if (typeof command !== "string" || command.trim() === "") return "command (string) is required";
      const bin = command.trim().split(/\s+/)[0];
      if (!bin || !allowlist.includes(bin)) return `command not allowed: ${bin ?? "(empty)"}`;
      return null;
    },
    async execute(input: ToolInput) {
      const parts = String(input.command).trim().split(/\s+/);
      const bin = parts[0]!;
      const args = parts.slice(1);
      const { stdout, stderr } = await sandbox.run(bin, args, { timeoutMs: 5000 });
      return { content: stdout || stderr, details: { argv: parts, sandbox: sandbox.name } };
    },
  };
}
