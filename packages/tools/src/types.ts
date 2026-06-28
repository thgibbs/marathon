import type { SecretStore } from "@marathon/config";
import type { RiskLevel } from "@marathon/core";

export type ToolInput = Record<string, unknown>;

export interface ToolResult {
  content: string;
  details?: Record<string, unknown>;
}

export interface ToolContext {
  taskId: string;
  tenantId: string;
  agentId?: string;
  /** Credentials are resolved here at execution — never placed in logged summaries. */
  secrets: SecretStore;
}

export interface Tool {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  /** Destructive/irreversible/externally-visible — gated by approval (design.md §5.4). */
  destructive: boolean;
  /** Validate input; return an error string, or null if valid. */
  validate?(input: ToolInput): string | null;
  execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolConstraints {
  allowedRepos?: string[];
  [k: string]: unknown;
}

export interface ToolGrant {
  tool: string;
  constraints?: ToolConstraints;
}

/** The agent version's tool grants (design.md §10.7). */
export interface ToolPolicy {
  grants: ToolGrant[];
}
