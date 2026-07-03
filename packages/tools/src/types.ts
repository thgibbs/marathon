import type { SecretStore } from "@marathon/config";
import type { RiskAxes, ToolDefaultMode } from "@marathon/core";

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

/**
 * Static sensitivity of a source a tool reads (design §7.8, §14.1): resource
 * visibility metadata, never a content classifier. Kernel calibration: all
 * repos are `company_viewable` until a customer needs finer tiers.
 */
export type SourceSensitivity = "public" | "company_viewable" | "restricted";

/** One source read by a tool call, recorded in the task's source ledger (§7.8). */
export interface SourceRead {
  /** Stable source identifier, e.g. `github:owner/repo`. */
  source: string;
  sensitivity: SourceSensitivity;
}

/**
 * Where a tool call's output lands when it egresses beyond the task context
 * (§7.8): the destination and how broad its audience is. `external` means the
 * effect leaves the tenant boundary — always a Proposed Effect, never direct.
 */
export interface EgressTarget {
  /** Stable destination identifier, e.g. `github:owner/repo#123`, `slack:C123`. */
  destination: string;
  audience: RiskAxes["audience"];
  /** Leaves the tenant boundary (external/public/Slack Connect/email-out). */
  external: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** Risk classification on the §7.8 axes (reversibility / trust boundary / audience / cost). */
  riskAxes: RiskAxes;
  /** Default handling mode (§7.8): autonomous | native_review | proposed_effect | disabled. */
  defaultMode: ToolDefaultMode;
  /**
   * Sources this call reads, derived from static input metadata — the gateway
   * records them in the task's source ledger before executing (§7.8).
   */
  sources?(input: ToolInput): SourceRead[];
  /**
   * The egress destination of this call, if its output lands beyond the task
   * context. The gateway routes it per the egress policy before executing (§7.8).
   */
  egress?(input: ToolInput): EgressTarget | null;
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
