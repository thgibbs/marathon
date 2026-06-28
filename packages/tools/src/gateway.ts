import type { SecretStore } from "@marathon/config";
import { redactSecrets, type RiskLevel } from "@marathon/core";
import { enforce, type PolicyDecision, type PolicyResult } from "./policy";
import type { RateLimiter } from "./rate-limit";
import type { Tool, ToolInput, ToolPolicy, ToolResult } from "./types";

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

export class ToolBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly decision: PolicyDecision,
  ) {
    super(reason);
    this.name = "ToolBlockedError";
  }
}

export interface ToolInvocationRecord {
  taskId: string;
  toolName: string;
  status: "ok" | "blocked" | "error";
  riskLevel: RiskLevel;
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
  onInvocation(rec: ToolInvocationRecord): Promise<void> | void;
  onAudit(event: AuditRecord): Promise<void> | void;
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
  rateLimiter?: RateLimiter;
  /** Redact secrets from recorded summaries (on by default). */
  redactTrace?: boolean;
}

/**
 * The single chokepoint for tool side effects (design.md §7.8): validate ->
 * rate-limit -> enforce policy -> inject credentials -> execute -> redact ->
 * record (ToolInvocation + audit). Credentials are resolved inside the tool via
 * `ctx.secrets` and never written to the recorded summaries.
 */
export interface RunOptions {
  /** Bypass the destructive -> needs_approval gate (an approval was granted). */
  approved?: boolean;
}

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
      await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskLevel: "low", inputSummary, error: "unknown tool" });
      await this.audit(ctx, "policy.denied", `unknown tool: ${toolName}`);
      throw new ToolBlockedError(`unknown tool: ${toolName}`, "deny");
    }

    const validationError = tool.validate?.(input) ?? null;
    if (validationError) {
      await this.record({ taskId: ctx.taskId, toolName, status: "error", riskLevel: tool.riskLevel, inputSummary, error: `invalid input: ${validationError}` });
      throw new Error(`invalid input for ${toolName}: ${validationError}`);
    }

    if (this.opts.rateLimiter && !this.opts.rateLimiter.allow(`${ctx.taskId}:${toolName}`)) {
      await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskLevel: tool.riskLevel, inputSummary, error: "rate limited" });
      await this.audit(ctx, "policy.denied", `rate limited: ${toolName}`);
      throw new ToolBlockedError(`rate limited: ${toolName}`, "deny");
    }

    const decision = enforce(this.opts.policy, tool, input);
    // A granted approval lets a destructive call through; deny is always terminal.
    const allowed = decision.decision === "allow" || (decision.decision === "needs_approval" && opts.approved === true);
    if (!allowed) {
      await this.record({ taskId: ctx.taskId, toolName, status: "blocked", riskLevel: tool.riskLevel, inputSummary, error: decision.reason });
      await this.audit(ctx, "policy.denied", `${decision.decision}: ${toolName} (${decision.reason ?? ""})`);
      throw new ToolBlockedError(decision.reason ?? "blocked", decision.decision);
    }

    try {
      const result = await tool.execute(input, { ...ctx, secrets: this.opts.secrets });
      const outputSummary = redact(result.content).slice(0, 2000);
      await this.record({ taskId: ctx.taskId, toolName, status: "ok", riskLevel: tool.riskLevel, inputSummary, outputSummary });
      await this.audit(ctx, "tool.called", `${toolName} ok`);
      return result;
    } catch (err) {
      await this.record({ taskId: ctx.taskId, toolName, status: "error", riskLevel: tool.riskLevel, inputSummary, error: redact(String(err)) });
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
