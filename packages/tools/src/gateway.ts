import type { SecretStore } from "@marathon/config";
import { redactSecrets, type RiskAxes } from "@marathon/core";
import type { SourceLedger } from "./ledger";
import { enforce, type PolicyDecision, type PolicyResult } from "./policy";
import type { EgressTarget, SourceRead, Tool, ToolInput, ToolPolicy, ToolResult } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

/**
 * Typed, agent-visible reasons a gateway call did not run. Stable codes so the
 * agent loop (and the code-handoff path) can react to *which* check failed
 * rather than parsing prose.
 */
export type GatewayErrorCode =
  | "unknown_tool"
  | "not_granted"
  | "constraint_violation"
  | "tool_disabled"
  | "requires_proposal"
  | "egress_blocked";

export class ToolBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly decision: PolicyDecision,
    public readonly code: GatewayErrorCode,
  ) {
    super(reason);
    this.name = "ToolBlockedError";
  }
}

/** Recorded axes for calls blocked before a tool was resolved. */
const UNRESOLVED_RISK_AXES: RiskAxes = {
  reversible: true,
  crossesTrustBoundary: false,
  audience: "private",
  costly: false,
};

export interface ToolInvocationRecord {
  taskId: string;
  toolName: string;
  status: "ok" | "blocked" | "error";
  /** The tool's declared §7.8 risk axes. */
  riskAxes: RiskAxes;
  inputSummary: string;
  outputSummary?: string;
  error?: string;
}

export interface AuditRecord {
  tenantId: string;
  eventType: string;
  summary: string;
  targetType?: string;
  targetId?: string;
  actorAgentId?: string;
}

export interface ToolRecorder {
  // Return value is awaited by the gateway; returning the underlying write promise
  // (rather than discarding it) ensures records/audits are durably persisted before
  // the tool call resolves.
  onInvocation(rec: ToolInvocationRecord): unknown | Promise<unknown>;
  onAudit(event: AuditRecord): unknown | Promise<unknown>;
}

export interface ToolCallContext {
  taskId: string;
  tenantId: string;
  agentId?: string;
}

export interface ToolGatewayOptions {
  registry: ToolRegistry;
  policy: ToolPolicy;
  secrets: SecretStore;
  recorder?: ToolRecorder;
  /**
   * Per-task source-sensitivity ledger (§7.8, §12.2). When set, governed reads
   * are recorded and egressing calls are routed against what the task has read.
   */
  sourceLedger?: SourceLedger;
  /** Redact secrets from recorded summaries (on by default). */
  redactTrace?: boolean;
}

export interface RunOptions {
  /**
   * @deprecated M5 scaffolding: lets a reviewed `requires_proposal` call
   * execute. M10 Proposed Effects use a non-model executor over immutable
   * artifacts (§7.9) — do not build new review flows on this flag.
   */
  approved?: boolean;
}

/**
 * The single chokepoint for tool side effects (design §7.8): validate ->
 * enforce policy -> record reads in the source ledger -> route egress ->
 * inject credentials -> execute -> redact -> record (ToolInvocation + audit).
 * A deterministic safety perimeter, not a policy brain — what an agent may do
 * is bounded by credential scope and the resource's own permissions.
 * Credentials are resolved inside the tool via `ctx.secrets` and never written
 * to the recorded summaries.
 */
export class ToolGateway {
  constructor(private readonly opts: ToolGatewayOptions) {}

  /** Evaluate the policy decision for a tool call without executing it. */
  evaluate(toolName: string, input: ToolInput): PolicyResult {
    const tool = this.opts.registry.get(toolName);
    if (!tool) return { decision: "deny", reason: `unknown tool: ${toolName}` };
    return enforce(this.opts.policy, tool, input);
  }

  async run(
    toolName: string,
    input: ToolInput,
    ctx: ToolCallContext,
    opts: RunOptions = {},
  ): Promise<ToolResult> {
    const redact = (s: string) => redactSecrets(s, { enabled: this.opts.redactTrace !== false });
    const inputSummary = redact(safeJson(input)).slice(0, 1000);
    const tool = this.opts.registry.get(toolName);

    if (!tool) {
      await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskAxes: UNRESOLVED_RISK_AXES, inputSummary, error: "unknown tool" });
      await this.audit(ctx, "policy.denied", `unknown tool: ${toolName}`);
      throw new ToolBlockedError(`unknown tool: ${toolName}`, "deny", "unknown_tool");
    }

    const validationError = tool.validate?.(input) ?? null;
    if (validationError) {
      await this.record({ taskId: ctx.taskId, toolName, status: "error", riskAxes: tool.riskAxes, inputSummary, error: `invalid input: ${validationError}` });
      throw new Error(`invalid input for ${toolName}: ${validationError}`);
    }

    const decision = enforce(this.opts.policy, tool, input);
    // The deprecated approved flag lets a reviewed requires_proposal call run; deny is always terminal.
    const allowed = decision.decision === "allow" || (decision.decision === "requires_proposal" && opts.approved === true);
    if (!allowed) {
      await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskAxes: tool.riskAxes, inputSummary, error: decision.reason });
      await this.audit(ctx, "policy.denied", `${decision.decision}: ${toolName} (${decision.reason ?? ""})`);
      throw new ToolBlockedError(decision.reason ?? "blocked", decision.decision, policyErrorCode(decision));
    }

    // Egress routing (§7.8): deterministic checks over the source ledger and the
    // declared destination — never a content classifier. The current call's own
    // declared reads count too, so a tool that reads and egresses in one call
    // cannot slip a restricted source past the check.
    const sourcesRead = tool.sources?.(input) ?? [];
    const egressTarget = tool.egress?.(input) ?? null;
    if (egressTarget) {
      const prior = this.opts.sourceLedger ? await this.opts.sourceLedger.list(ctx.taskId) : [];
      const violation = checkEgress(egressTarget, [...prior, ...sourcesRead]);
      if (violation) {
        await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskAxes: tool.riskAxes, inputSummary, error: violation });
        await this.audit(ctx, "egress.denied", `${toolName} -> ${egressTarget.destination}: ${violation}`);
        throw new ToolBlockedError(violation, "deny", "egress_blocked");
      }
    }

    // Record reads before executing (§7.8: the ledger reflects everything handed
    // to the model, even if a later step fails).
    if (sourcesRead.length && this.opts.sourceLedger) {
      await this.opts.sourceLedger.record(ctx.taskId, sourcesRead);
    }

    try {
      const result = await tool.execute(input, { ...ctx, secrets: this.opts.secrets });
      const outputSummary = redact(result.content).slice(0, 2000);
      await this.record({ taskId: ctx.taskId, toolName, status: "ok", riskAxes: tool.riskAxes, inputSummary, outputSummary });
      await this.audit(ctx, "tool.called", `${toolName} ok`);
      return result;
    } catch (err) {
      await this.record({ taskId: ctx.taskId, toolName, status: "error", riskAxes: tool.riskAxes, inputSummary, error: redact(String(err)) });
      throw err;
    }
  }

  private async record(rec: ToolInvocationRecord): Promise<void> {
    await this.opts.recorder?.onInvocation(rec);
  }

  private async audit(ctx: ToolCallContext, eventType: string, summary: string): Promise<void> {
    await this.opts.recorder?.onAudit({
      tenantId: ctx.tenantId,
      eventType,
      summary,
      targetType: "task",
      targetId: ctx.taskId,
      actorAgentId: ctx.agentId,
    });
  }
}

/**
 * Deterministic egress routing (§7.8), kernel calibration: egress that leaves
 * the tenant boundary is always a Proposed Effect (none registered in the
 * kernel, so direct calls are blocked); internal egress flows unless the task
 * read a `restricted` source (kernel default: repo content is
 * `company_viewable`, so nothing trips this until finer tiers are configured).
 */
export function checkEgress(target: EgressTarget, sources: SourceRead[]): string | null {
  if (target.external || target.audience === "external" || target.audience === "public") {
    return `tenant-external egress to ${target.destination} must go through a Proposed Effect (§7.9), not a direct tool call`;
  }
  const restricted = sources.filter((s) => s.sensitivity === "restricted");
  if (restricted.length > 0) {
    const names = restricted.map((s) => s.source).join(", ");
    return `this task read restricted source(s) [${names}] — egress to ${target.destination} is denied (§7.8)`;
  }
  return null;
}

function policyErrorCode(result: PolicyResult): GatewayErrorCode {
  if (result.decision === "requires_proposal") return "requires_proposal";
  const reason = result.reason ?? "";
  if (reason.startsWith("tool not granted")) return "not_granted";
  if (reason.startsWith("tool is disabled")) return "tool_disabled";
  return "constraint_violation";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
