import { parse } from "yaml";
import type { VerificationResult } from "@marathon/core";

export type VerifySource = "repo_config" | "plan_doc" | "agent_judgment";

export interface VerifyDiscovery {
  source: VerifySource;
  /** Empty with source "agent_judgment": the agent picks (`make test`, `pnpm test`, …). */
  commands: string[];
}

export interface VerifyDiscoveryInput {
  /** Read a file from the workspace; null when it does not exist. */
  readFile: (path: string) => Promise<string | null>;
  /** The merged plan's doc path, for the Verification-section fallback. */
  planDocPath?: string;
}

/**
 * Discover the verify commands in precedence order (design §29.3):
 * 1. repo config — `verify:` list in `.marathon/config.yml`;
 * 2. the plan doc's own Verification section;
 * 3. agent judgment.
 */
export async function discoverVerifyCommands(input: VerifyDiscoveryInput): Promise<VerifyDiscovery> {
  const config = await input.readFile(".marathon/config.yml");
  if (config !== null) {
    const commands = verifyCommandsFromConfig(config);
    if (commands.length > 0) return { source: "repo_config", commands };
  }

  if (input.planDocPath) {
    const plan = await input.readFile(input.planDocPath);
    if (plan !== null) {
      const commands = verifyCommandsFromPlan(plan);
      if (commands.length > 0) return { source: "plan_doc", commands };
    }
  }

  return { source: "agent_judgment", commands: [] };
}

export function verifyCommandsFromConfig(yamlText: string): string[] {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return [];
  }
  const verify = (doc as { verify?: unknown } | null)?.verify;
  if (!Array.isArray(verify)) return [];
  return verify.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
}

/**
 * Extract commands from the plan's Verification section: the lines of fenced
 * code blocks, plus backtick-quoted commands in list items.
 */
export function verifyCommandsFromPlan(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+verification\b/i.test(l));
  if (start === -1) return [];
  const level = (/^#{1,6}/.exec(lines[start] ?? "") ?? [""])[0]?.length ?? 2;

  const commands: string[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,6})\s/.exec(line);
    if (!inFence && heading && (heading[1]?.length ?? 0) <= level) break;
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith("#")) commands.push(cmd);
    } else {
      const item = /^\s*[-*]\s+.*`([^`]+)`/.exec(line);
      if (item?.[1]) commands.push(item[1]);
    }
  }
  return commands;
}

/** Green = at least one command was run and every one exited 0 (§29.3). */
export function isVerificationGreen(results: VerificationResult[]): boolean {
  return results.length > 0 && results.every((r) => r.exitCode === 0);
}
