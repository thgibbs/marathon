import type { SecretStore } from "@marathon/config";
import {
  computeCostUsd,
  parseModelRef,
  ModelRegistry,
  resolveApiKey,
} from "@marathon/model-gateway";
import type { AgentRuntime, AgentTurn, AgentTurnContext } from "./types";

/**
 * Real Pi-harness adapter (@earendil-works/pi-coding-agent).
 *
 * IMPORTANT: this adapter is implemented against the documented + verified Pi
 * API but is NOT exercised in CI (it needs a live model + network). It runs the
 * whole prompt as a single turn for M2 (done=true); turn-by-turn suspend/resume
 * is the §6.1 / M5 work. Use `make smoke-pi` locally with a real key.
 *
 * Pi is loaded via a runtime (non-literal) dynamic import so the type checker
 * stays decoupled from Pi's internal types.
 */
export interface PiAgentOptions {
  secrets: SecretStore;
  registry?: ModelRegistry;
  /** Where Pi stores its per-task session JSONL (the durable trace/checkpoint). */
  sessionDir?: string;
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

    const sessionManager = this.opts.sessionDir
      ? pi.SessionManager.create(this.opts.sessionDir)
      : pi.SessionManager.inMemory();

    const loader = new pi.DefaultResourceLoader({
      systemPromptOverride: () => ctx.request.instructions,
    });
    await loader.reload();

    const start = Date.now();
    const { session } = await pi.createAgentSession({
      model: piModel,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager,
      tools: ["read", "grep", "find", "ls"], // read-only for M2
    });

    let text = "";
    session.subscribe((event: any) => {
      if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    await session.prompt(ctx.request.input);

    const latencyMs = Date.now() - start;
    const usage = readUsage(session);
    const costUsd = spec ? computeCostUsd(spec, usage) : null;

    try {
      session.dispose?.();
    } catch {
      // ignore
    }

    return {
      text,
      done: true,
      modelInvocation: {
        provider,
        model,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        costUsd,
        latencyMs,
        status: "ok",
      },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readUsage(session: any): { inputTokens?: number; outputTokens?: number } {
  const stats = session?.stats ?? session?.sessionStats;
  const tokens = stats?.tokens ?? {};
  return {
    inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
    outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
  };
}
