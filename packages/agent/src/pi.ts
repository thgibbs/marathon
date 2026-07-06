import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
import type {
  AgentRequest,
  AgentRuntime,
  AgentTurn,
  AgentTurnContext,
  AgentWorkspaceBinding,
  ModelInvocationData,
} from "./types";

/**
 * Real Pi-harness adapter (@earendil-works/pi-coding-agent).
 *
 * Runtime-verified locally via `make smoke-pi` / `make smoke-k4` (real model
 * calls through Pi); not run in CI, which uses the fake/scripted runtimes for
 * determinism.
 *
 * Durable multi-turn (K4, design §11.2): each task gets its own session JSONL
 * under `sessionDir/<taskId>/`. After every completed Pi turn (`turn_end`) the
 * live session file is snapshotted and reported through
 * {@link AgentTurnContext.onTurnCheckpoint}; resuming from a snapshot discards
 * any later, incomplete turn (turn atomicity — a crash mid-turn replays it).
 * A call with `checkpoint.sessionRef` set re-opens that session and continues.
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
  /** Called when a call is refused because the effect must be proposed for review (§7.9). */
  onProposalRequired?: (toolName: string, input: Record<string, unknown>, reason: string) => Promise<void> | void;
}

export interface PiAgentOptions {
  secrets: SecretStore;
  registry?: ModelRegistry;
  /**
   * Where Pi stores its per-task session JSONL (the durable trace/checkpoint).
   * Each task gets its own subdirectory; per-turn snapshots live next to the
   * live session file. Unset → in-memory sessions (no durable resume).
   */
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
   * Route Pi's `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` tools into a hardened
   * sandbox container (§12.6, Pattern 2). When set, those tools execute inside a fresh {@link DockerContainer}
   * (no host credentials; outbound internet allowed) against a bind-mounted workspace, while governed
   * tools stay host-side. `createContainer` returns a *not-yet-started* container bound to
   * this task's workspace; the runtime owns `start()`/`stop()` for the call. Containers
   * are never recovered across calls (§11.2) — every call gets a fresh one.
   */
  sandbox?: {
    createContainer: (
      req: AgentRequest,
      workspace?: AgentWorkspaceBinding,
    ) => Promise<DockerContainer> | DockerContainer;
    shellPath?: string;
  };
  /**
   * Expose the `ask_user` clarification tool (Track 12, §11.6): the agent asks
   * one question, the run ends in a durable wait (`AgentTurn.waiting`), and the
   * worker parks the task until a surface reply resumes the session.
   */
  clarification?: boolean;
}

const PI_MODULE: string = "@earendil-works/pi-coding-agent";

/** Cap for tool-event summaries surfaced to the task timeline. */
const EVENT_SUMMARY_CAP = 400;

/**
 * Open the task's durable Pi session: resume from `sessionRef` when it points
 * at an existing snapshot/file, otherwise create a fresh session under the
 * per-task directory (in-memory when no directory is configured). Exported for
 * tests — this is the resume decision the K4 contract hangs off.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolvePiSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi: any,
  opts: { cwd: string; taskSessionDir?: string; sessionRef?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { sessionManager: any; resumed: boolean } {
  if (opts.sessionRef && existsSync(opts.sessionRef)) {
    return {
      sessionManager: pi.SessionManager.open(opts.sessionRef, opts.taskSessionDir, opts.cwd),
      resumed: true,
    };
  }
  if (opts.taskSessionDir) {
    mkdirSync(opts.taskSessionDir, { recursive: true });
    return { sessionManager: pi.SessionManager.create(opts.cwd, opts.taskSessionDir), resumed: false };
  }
  return { sessionManager: pi.SessionManager.inMemory(opts.cwd), resumed: false };
}

export class PiAgentRuntime implements AgentRuntime {
  constructor(private readonly opts: PiAgentOptions) {}

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
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

    // Durable session per task (K4): resume from the checkpointed snapshot when
    // present, else start fresh under sessionDir/<taskId>/.
    const taskSessionDir = this.opts.sessionDir
      ? join(this.opts.sessionDir, ctx.request.taskId)
      : undefined;
    const { sessionManager } = resolvePiSession(pi, {
      cwd,
      taskSessionDir,
      sessionRef: ctx.checkpoint.sessionRef,
    });

    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => ctx.request.instructions,
    });
    await loader.reload();

    const start = Date.now();
    // Marathon-governed tools (M6.1): each Pi custom tool delegates to the Tool
    // Gateway, so policy/credentials/audit/redaction apply, and high-risk calls
    // surface a requires-proposal outcome to the model (§7.9).
    const customTools: unknown[] = [];
    const governedNames: string[] = [];
    if (this.opts.governed) {
      const { gateway, tools: specs, onProposalRequired } = this.opts.governed;
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
              if (outcome.status === "requires_proposal") {
                await onProposalRequired?.(spec.name, params ?? {}, outcome.reason);
              }
              return { content: [{ type: "text", text: governedOutcomeText(outcome) }], details: {} };
            },
          }),
        );
      }
    }

    // Clarifying questions (Track 12): the tool captures the question; after the
    // run ends, a captured question turns the result into a durable wait.
    let pendingQuestion: string | undefined;
    const clarifyNames: string[] = [];
    if (this.opts.clarification) {
      clarifyNames.push("ask_user");
      customTools.push(
        pi.defineTool({
          name: "ask_user",
          label: "ask_user",
          description:
            "Ask the user ONE clarifying question when you cannot proceed without their answer. " +
            "The task pauses until they reply — after calling this, STOP working and end your response.",
          parameters: {
            type: "object",
            properties: { question: { type: "string", description: "The question for the user." } },
            required: ["question"],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          execute: async (_id: string, params: any) => {
            pendingQuestion = String(params?.question ?? "").trim() || "(no question given)";
            return {
              content: [
                { type: "text", text: "Question sent to the user. Stop here — the task resumes when they answer." },
              ],
              details: {},
            };
          },
        }),
      );
    }

    // Sandbox tool routing (§12.6, Pattern 2): bash/read/write/edit execute inside a
    // hardened container against a bind-mounted workspace; governed tools stay host-side.
    let container: DockerContainer | undefined;
    const sandboxNames: string[] = [];
    if (this.opts.sandbox) {
      container = await this.opts.sandbox.createContainer(ctx.request, ctx.workspace);
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
        tools: [...(this.opts.builtinTools ?? []), ...sandboxNames, ...governedNames, ...clarifyNames],
      });

      let streamed = "";
      const eventTypes: string[] = [];
      // Progress/streaming events (best-effort, fire-and-forget).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.subscribe((event: any) => {
        if (event?.type) eventTypes.push(event.type);
        if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          streamed += event.assistantMessageEvent.delta;
        }
        if (event?.type === "tool_execution_start") {
          ctx.onEvent?.({
            type: "tool_start",
            toolName: String(event.toolName ?? ""),
            summary: cap(safeJson(event.args)),
          });
        }
        if (event?.type === "tool_execution_end") {
          ctx.onEvent?.({
            type: "tool_end",
            toolName: String(event.toolName ?? ""),
            summary: cap(`${event.isError ? "error" : "ok"}: ${safeJson(event.result)}`),
          });
        }
      });

      // Per-turn checkpoints (K4, §11.2): the checkpoint unit is one completed Pi
      // turn, and "after each completed turn, persist" is load-bearing — so the
      // checkpoint runs in an AWAITED agent-level listener. Pi's run loop awaits
      // these listeners before starting the next turn, and a persist failure
      // fails the run AT the turn boundary (a run that cannot checkpoint must
      // not keep doing work it cannot resume from).
      const turnBase = (ctx.checkpoint.turnIndex ?? -1) + 1;
      let turnsThisCall = 0;
      let lastSessionRef: string | undefined = ctx.checkpoint.sessionRef;
      let checkpointError: unknown;
      if (!session.agent?.subscribe) {
        throw new Error("Pi session does not expose awaited agent listeners; cannot checkpoint per turn");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubscribe = session.agent.subscribe(async (event: any) => {
        if (event?.type !== "turn_end") return;
        // A failed run replays a synthetic error turn_end (and one fires after a
        // checkpoint failure): neither is a COMPLETED turn — never checkpoint it.
        if (checkpointError || event.message?.errorMessage) return;
        const turnIndex = turnBase + turnsThisCall;
        turnsThisCall += 1;
        // Snapshot the session file at the turn boundary: the snapshot IS the
        // resume point; anything appended after it (a turn interrupted by a
        // crash) is discarded on resume.
        const live: string | undefined = sessionManager.getSessionFile?.();
        let snapshot: string | undefined;
        if (live && taskSessionDir) {
          snapshot = join(taskSessionDir, `turn-${turnIndex}.jsonl`);
          copyFileSync(live, snapshot);
          lastSessionRef = snapshot;
        }
        ctx.onEvent?.({ type: "turn_end", summary: `turn ${turnIndex} complete` });
        if (ctx.onTurnCheckpoint) {
          try {
            const modelInvocation = perTurnInvocation(event.message, provider, model);
            await ctx.onTurnCheckpoint({ turnIndex, sessionRef: snapshot ?? live, modelInvocation });
          } catch (err) {
            checkpointError = err;
            throw err instanceof Error ? err : new Error(String(err));
          }
        }
      });

      try {
        await session.prompt(ctx.request.input);
      } finally {
        unsubscribe?.();
      }
      // A run whose checkpoint failed was stopped at that turn boundary; surface
      // the real cause instead of the synthesized model-error message.
      if (checkpointError) {
        throw checkpointError instanceof Error
          ? checkpointError
          : new Error(`turn checkpoint failed: ${String(checkpointError)}`);
      }

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

      const finalSessionRef: string | undefined = sessionManager.getSessionFile?.() ?? lastSessionRef;
      return {
        text,
        // An asked question turns this run into a durable wait (Track 12): not
        // done — the worker parks the task and the answer re-opens the session.
        done: pendingQuestion === undefined,
        waiting: pendingQuestion !== undefined ? { question: pendingQuestion } : undefined,
        sessionRef: finalSessionRef,
        turnIndex: turnsThisCall > 0 ? turnBase + turnsThisCall - 1 : ctx.checkpoint.turnIndex,
        // With a per-turn checkpoint sink, usage is accounted turn-by-turn there;
        // reporting the last message again here would double-count it.
        modelInvocation: ctx.onTurnCheckpoint
          ? undefined
          : { provider, model, inputTokens, outputTokens, costUsd, latencyMs, status: "ok" },
      };
    } finally {
      if (container) await container.stop().catch(() => {});
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Per-turn usage from Pi's turn_end assistant message (best-effort). */
function perTurnInvocation(message: any, provider: string, model: string): ModelInvocationData | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    provider,
    model,
    inputTokens: numberOrNull(usage.input),
    outputTokens: numberOrNull(usage.output),
    costUsd: numberOrNull(usage.cost?.total),
    status: "ok",
  };
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

function cap(s: string): string {
  return s.length > EVENT_SUMMARY_CAP ? `${s.slice(0, EVENT_SUMMARY_CAP)}…` : s;
}

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
