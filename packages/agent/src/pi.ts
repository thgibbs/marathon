import type { SecretStore } from "@marathon/config";
import {
  computeCostUsd,
  parseModelRef,
  ModelRegistry,
  resolveApiKey,
} from "@marathon/model-gateway";
import type { DockerContainer } from "@marathon/tools";
import { governedOutcomeText, runGovernedTool } from "./governed";
import { buildDockerSandboxTools } from "./sandbox-tools";
import type { AgentRequest, AgentRuntime, AgentTurn, AgentTurnContext } from "./types";

/**
 * Real Pi-harness adapter (@earendil-works/pi-coding-agent).
 *
 * Runtime-verified locally via `make smoke-pi` (a real model call through Pi);
 * not run in CI, which uses FakeAgentRuntime for determinism. Runs the whole
 * prompt as a single turn for M2 (done=true); turn-by-turn suspend/resume is the
 * §6.1 / M5 work.
 *
 * Pi is loaded via a runtime (non-literal) dynamic import so the type checker
 * stays decoupled from Pi's internal types.
 */
/** A Marathon-governed tool exposed to the Pi agent (M6.1). */
export interface GovernedToolSpec {
  name: string;
  description: string;
  /** JSON-schema-ish parameters shown to the model. */
  parameters: Record<string, unknown>;
}

export interface GovernedToolsConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gateway: any; // @marathon/tools ToolGateway (kept loose to avoid a hard dep cycle)
  tools: GovernedToolSpec[];
  onApprovalRequired?: (toolName: string, input: Record<string, unknown>, reason: string) => Promise<void> | void;
}

export interface PiAgentOptions {
  secrets: SecretStore;
  registry?: ModelRegistry;
  /** Where Pi stores its per-task session JSONL (the durable trace/checkpoint). */
  sessionDir?: string;
  /** Marathon-governed tools to expose to the agent (M6.1). */
  governed?: GovernedToolsConfig;
  /**
   * Pi's built-in tools to enable (e.g. "read", "grep", "find", "ls"). **Default: none.**
   * They run ungoverned against the harness filesystem (§2b #2), so they should only be
   * enabled inside a sandboxed workspace (§12.6). Governed tools are always exposed.
   */
  builtinTools?: string[];
  /**
   * Route Pi's `bash`/`read`/`write`/`edit` tools into a hardened sandbox container
   * (§12.6, Pattern 2). When set, those tools execute inside a fresh {@link DockerContainer}
   * (no network, no host credentials) against a bind-mounted workspace, while governed
   * tools stay host-side. `createContainer` returns a *not-yet-started* container bound to
   * this task's workspace; the runtime owns `start()`/`stop()` for the turn.
   */
  sandbox?: {
    createContainer: (req: AgentRequest) => Promise<DockerContainer> | DockerContainer;
    shellPath?: string;
  };
}

const PI_MODULE: string = "@earendil-works/pi-coding-agent";

export class PiAgentRuntime implements AgentRuntime {
  constructor(private readonly opts: PiAgentOptions) {}

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    // already finished (single-turn for M2)
    if (ctx.checkpoint.completedSteps.length > 0) {
      return { text: "", done: true };
    }

    const { provider, model } = parseModelRef(ctx.request.modelRef);
    const registry = this.opts.registry ?? new ModelRegistry();
    const spec = registry.get(ctx.request.modelRef);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi: any = await import(PI_MODULE);

    const authStorage = pi.AuthStorage.create();
    const apiKey = await resolveApiKey(this.opts.secrets, provider);
    if (apiKey) authStorage.setRuntimeApiKey(provider, apiKey);

    const modelRegistry = pi.ModelRegistry.create(authStorage);
    const piModel = modelRegistry.find(provider, model);
    if (process.env.PI_DEBUG) {
      const avail = (await modelRegistry.getAvailable?.()) ?? [];
      console.error("[pi] available models:", avail.length, "piModel:", piModel?.id ?? piModel);
    }

    const cwd = process.cwd();
    const agentDir = typeof pi.getAgentDir === "function" ? pi.getAgentDir() : cwd;

    const sessionManager = this.opts.sessionDir
      ? pi.SessionManager.create(this.opts.sessionDir)
      : pi.SessionManager.inMemory();

    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => ctx.request.instructions,
    });
    await loader.reload();

    const start = Date.now();
    // Marathon-governed tools (M6.1): each Pi custom tool delegates to the Tool
    // Gateway, so policy/credentials/audit/redaction apply, and destructive calls
    // surface an approval requirement to the model.
    const customTools: unknown[] = [];
    const governedNames: string[] = [];
    if (this.opts.governed) {
      const { gateway, tools: specs, onApprovalRequired } = this.opts.governed;
      // Per-call ctx from this turn's request (the runtime is shared across tasks),
      // falling back to a configured ctx for single-shot uses.
      const govCtx = {
        taskId: ctx.request.taskId,
        tenantId: ctx.request.tenantId ?? "",
        agentId: ctx.request.agentId,
      };
      for (const spec of specs) {
        // Model-facing tool names must match ^[A-Za-z0-9_-]+$ (no dots); map back
        // to the real Marathon tool name when calling the gateway.
        const modelName = spec.name.replace(/[^A-Za-z0-9_-]/g, "_");
        governedNames.push(modelName);
        customTools.push(
          pi.defineTool({
            name: modelName,
            label: modelName,
            description: spec.description,
            parameters: spec.parameters,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            execute: async (_id: string, params: any) => {
              const outcome = await runGovernedTool(gateway, spec.name, params ?? {}, govCtx);
              if (outcome.status === "approval_required") {
                await onApprovalRequired?.(spec.name, params ?? {}, outcome.reason);
              }
              return { content: [{ type: "text", text: governedOutcomeText(outcome) }], details: {} };
            },
          }),
        );
      }
    }

    // Sandbox tool routing (§12.6, Pattern 2): bash/read/write/edit execute inside a
    // hardened container against a bind-mounted workspace; governed tools stay host-side.
    let container: DockerContainer | undefined;
    const sandboxNames: string[] = [];
    if (this.opts.sandbox) {
      container = await this.opts.sandbox.createContainer(ctx.request);
      await container.start();
      const { tools, names } = buildDockerSandboxTools(pi, container, { shellPath: this.opts.sandbox.shellPath });
      customTools.push(...tools);
      sandboxNames.push(...names);
    }

    try {
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir,
      model: piModel,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager,
      customTools,
      // Built-ins are OFF by default (they bypass the gateway, §2b #2); enable only
      // inside a sandboxed workspace. Sandboxed + governed tools are exposed explicitly.
      tools: [...(this.opts.builtinTools ?? []), ...sandboxNames, ...governedNames],
    });

    let streamed = "";
    const eventTypes: string[] = [];
    session.subscribe((event: any) => {
      if (event?.type) eventTypes.push(event.type);
      if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
      }
    });

    await session.prompt(ctx.request.input);

    const latencyMs = Date.now() - start;
    if (process.env.PI_DEBUG) {
      console.error("[pi] events:", eventTypes.join(","));
      console.error("[pi] session keys:", Object.keys(session));
      try {
        console.error("[pi] messages:", JSON.stringify(session.messages)?.slice(0, 1200));
      } catch {
        /* ignore */
      }
    }

    const last = lastAssistantMessage(session);

    // Surface real model errors (e.g. billing/rate-limit) instead of hiding them.
    if (last?.errorMessage || last?.stopReason === "error") {
      try {
        session.dispose?.();
      } catch {
        /* ignore */
      }
      throw new Error(`model error: ${last?.errorMessage ?? "unknown error"}`);
    }

    const text = streamed || textFromMessage(last);
    const inputTokens = numberOrNull(last?.usage?.input);
    const outputTokens = numberOrNull(last?.usage?.output);
    // Prefer Pi's own computed cost; fall back to our model spec.
    const piCost = numberOrNull(last?.usage?.cost?.total);
    const costUsd =
      piCost ?? (spec ? computeCostUsd(spec, { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }) : null);

    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }

    return {
      text,
      done: true,
      modelInvocation: { provider, model, inputTokens, outputTokens, costUsd, latencyMs, status: "ok" },
    };
    } finally {
      if (container) await container.stop().catch(() => {});
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function lastAssistantMessage(session: any): any | undefined {
  const messages: any[] = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function textFromMessage(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
