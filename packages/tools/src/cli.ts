import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolInput } from "./types";

const execFileAsync = promisify(execFile);

/**
 * A command-line tool — Marathon's primary tool type (design.md §14.5). Commands
 * are restricted to an allowlist of binaries. NOTE: this runs unsandboxed; real
 * isolation (Gondolin/OpenShell) is M9 (design.md §12.6).
 */
export function makeCliTool(allowlist: string[]): Tool {
  return {
    name: "cli.run",
    description: "Run an allowlisted command-line program.",
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
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
      return { content: stdout || stderr, details: { argv: parts } };
    },
  };
}
