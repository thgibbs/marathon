import type { ModelSpec } from "@marathon/model-gateway";
import { computeCostUsd } from "@marathon/model-gateway";
import type { AgentProgressEvent } from "./types";

/**
 * Pure parsing of Codex CLI's `codex exec --json` events (codex-cli-impl.md
 * §2.2/§4.2). Kept separate from the runtime so the mapping — events →
 * progress/usage/result → {@link AgentTurn} — is unit-testable with no process,
 * container, or CLI. The event schema is pinned against the July 2026 reference
 * docs; the exact `turn.completed` usage shape is a verify-on-pin item (§10 #2),
 * so usage is parsed defensively (two shapes accepted; missing → undefined,
 * never NaN).
 *
 * Event shape (§1): newline-delimited JSON, one object per line:
 *   - `thread.started`  — carries the session/thread id (§2.2 — capture it)
 *   - `turn.started`
 *   - `item.started` / `item.completed` — agent messages, reasoning, command
 *     execution, file changes, MCP tool calls, web searches
 *   - `turn.completed` — final agent message + usage
 *   - `turn.failed`     — the turn failed (not-done; checkpoint + retry)
 */

/**
 * Defensive union of the two `turn.completed` usage shapes seen in the wild
 * (§4.3, verify-on-pin #2): an `input_tokens`/`output_tokens` object, or a
 * nested `token_usage` object of the same. Fields are optional; absent → the
 * reducer leaves the count undefined rather than coercing to NaN.
 */
export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  /** Some builds nest the counts under `token_usage`. */
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodexEvent = { type: string; [k: string]: any };

const EVENT_SUMMARY_CAP = 400;

function cap(s: string): string {
  return s.length > EVENT_SUMMARY_CAP ? `${s.slice(0, EVENT_SUMMARY_CAP)}…` : s;
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  } catch {
    return String(v);
  }
}

/** A finite number, or undefined — never NaN (defensive usage parse, §4.3). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize either usage shape into `{ input, output, cached }` with undefined
 * for absent counts. The `token_usage`-nested shape takes precedence over the
 * flat shape only per-field (a field present at the top wins if the nested one
 * is absent), so a partial event never zeroes a real count.
 */
export function readUsage(u: CodexUsage | undefined): {
  input?: number;
  output?: number;
  cached?: number;
} {
  if (!u || typeof u !== "object") return {};
  const nested = u.token_usage;
  return {
    input: num(u.input_tokens) ?? num(nested?.input_tokens),
    output: num(u.output_tokens) ?? num(nested?.output_tokens),
    cached: num(u.cached_input_tokens) ?? num(nested?.cached_input_tokens),
  };
}

/** Parse one JSONL line; returns null for blank/malformed lines (skipped, not fatal). */
export function parseStreamJsonLine(line: string): CodexEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && typeof v.type === "string" ? (v as CodexEvent) : null;
  } catch {
    return null;
  }
}

/**
 * The kind of an `item.*` event, if we can tell (cosmetic — only drives the
 * progress-event tool name/summary). Codex tags items with a `type`/`item_type`
 * discriminant; we read whichever is present and fall back to a generic label.
 */
function itemLabel(item: unknown): { kind: string; toolName: string; summary: string } {
  const it = (item ?? {}) as Record<string, unknown>;
  const kind = String(it.item_type ?? it.type ?? "item");
  // A human-facing tool name per known kind; unknown kinds carry their raw kind.
  const toolName =
    kind === "command_execution" || kind === "command"
      ? "command"
      : kind === "file_change" || kind === "patch"
        ? "file_change"
        : kind === "mcp_tool_call" || kind === "tool_call"
          ? String(it.tool ?? it.name ?? "mcp_tool_call")
          : kind === "web_search"
            ? "web_search"
            : kind;
  // A best-effort summary from whatever detail the item carries.
  const detail = it.command ?? it.path ?? it.query ?? it.arguments ?? it.text ?? it.title ?? it.name;
  return { kind, toolName, summary: cap(safeJson(detail ?? kind)) };
}

/** Item kinds that carry the agent's user-visible message text (final answer / streamed). */
function isAgentMessage(kind: string): boolean {
  return kind === "agent_message" || kind === "assistant_message" || kind === "message";
}

/** Extract message text from an agent-message item (string or content-blocks). */
function messageText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  const content = item.content ?? item.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/**
 * Incremental accumulator over the Codex event stream. The runtime feeds each
 * parsed event as it arrives; per-event usage — IF the stream carries it before
 * `turn.completed` — powers a mid-invocation budget kill (§4.3), otherwise the
 * only usage lands on `turn.completed`.
 */
export class CodexStreamAccumulator {
  /** The session/thread id from `thread.started` (§2.2). Undefined ⇒ died before it. */
  sessionId?: string;
  /** Streamed agent-message text (fallback for the `turn.completed` final message). */
  streamedText = "";
  /** The final agent message on `turn.completed`, when present. */
  finalMessage?: string;
  /** The terminal event: "completed" | "failed" | undefined (no terminal seen). */
  terminal?: "completed" | "failed";
  /** A failure reason from `turn.failed`, for the surfaced error. */
  failureReason?: string;
  /** Accumulated usage across the invocation (defensive; absent counts stay 0). */
  usage = { input: 0, output: 0, cached: 0 };
  /** Whether ANY usage was observed before `turn.completed` (gates the mid-turn kill, §4.3). */
  sawUsageBeforeTerminal = false;

  push(event: CodexEvent, onEvent?: (ev: AgentProgressEvent) => void): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.sessionId = event.thread_id;
        else if (typeof event.session_id === "string") this.sessionId = event.session_id;
        else if (typeof event.id === "string") this.sessionId = event.id;
        break;
      case "item.started": {
        const { kind, toolName, summary } = itemLabel(event.item ?? event);
        // Agent messages aren't a "tool"; only surface real tool/action items.
        if (!isAgentMessage(kind)) onEvent?.({ type: "tool_start", toolName, summary });
        break;
      }
      case "item.completed": {
        const item = (event.item ?? event) as Record<string, unknown>;
        const { kind, summary } = itemLabel(item);
        if (isAgentMessage(kind)) {
          // Streamed text (fallback for the final message on turn.completed).
          this.streamedText += messageText(item);
        } else {
          onEvent?.({ type: "tool_end", summary });
        }
        // Some builds attach per-item usage; fold it in if so (§4.3).
        this.maybeUsage(item.usage as CodexUsage | undefined);
        break;
      }
      case "turn.completed": {
        this.terminal = "completed";
        // The final agent message may ride the terminal event or be the last
        // streamed agent-message item; prefer the explicit terminal field.
        const msg = event.agent_message ?? event.final_message ?? event.text;
        if (typeof msg === "string") this.finalMessage = msg;
        else if (event.item) this.finalMessage = messageText(event.item as Record<string, unknown>);
        // Usage lands here (the confirmed carrier); accept both shapes.
        this.addUsage(readUsage(event.usage as CodexUsage | undefined));
        break;
      }
      case "turn.failed":
        this.terminal = "failed";
        this.failureReason =
          (typeof event.error === "string" && event.error) ||
          (event.error && typeof event.error === "object" && typeof event.error.message === "string"
            ? event.error.message
            : undefined) ||
          (typeof event.reason === "string" ? event.reason : undefined);
        break;
    }
  }

  /** Fold in per-event usage seen BEFORE the terminal event (sets the gate flag). */
  private maybeUsage(u: CodexUsage | undefined): void {
    if (!u) return;
    const r = readUsage(u);
    if (r.input === undefined && r.output === undefined && r.cached === undefined) return;
    this.sawUsageBeforeTerminal = true;
    this.addUsage(r);
  }

  private addUsage(r: { input?: number; output?: number; cached?: number }): void {
    this.usage.input += r.input ?? 0;
    this.usage.output += r.output ?? 0;
    this.usage.cached += r.cached ?? 0;
  }

  /** Estimated cost from accumulated tokens (for the mid-invocation budget kill, §4.3). */
  estimatedCostUsd(spec: ModelSpec | undefined): number {
    if (!spec) return 0;
    return computeCostUsd(spec, {
      inputTokens: this.usage.input,
      outputTokens: this.usage.output,
      cacheReadTokens: this.usage.cached,
    });
  }

  /** The final agent text: the terminal message when present, else the streamed text. */
  finalText(): string {
    return this.finalMessage ?? this.streamedText;
  }
}

/** Feed a whole event list through a fresh accumulator (test convenience). */
export function reduceStreamJson(
  events: CodexEvent[],
  onEvent?: (ev: AgentProgressEvent) => void,
): CodexStreamAccumulator {
  const acc = new CodexStreamAccumulator();
  for (const ev of events) acc.push(ev, onEvent);
  return acc;
}

export interface TurnInterpretation {
  /** `turn.completed` → done; `turn.failed`/no terminal → not-done (§2.2). */
  done: boolean;
  /** A hard failure (`turn.failed`, or the process died before any terminal). */
  error?: string;
}

/**
 * Map the terminal event onto done/error (§2.2). `turn.completed` completes the
 * harness turn; `turn.failed` ends it not-done with an error the runtime
 * surfaces so the step runner retries from the last snapshot. A run that
 * produced NO session id died before `thread.started` — a fresh-start retry
 * (§2.2), surfaced as an error here.
 */
export function interpretResult(acc: CodexStreamAccumulator): TurnInterpretation {
  if (acc.terminal === "completed") return { done: true };
  if (acc.terminal === "failed") {
    return { done: false, error: `codex turn failed${acc.failureReason ? `: ${acc.failureReason}` : ""}` };
  }
  // No terminal event. If we never even captured a session id, the process died
  // before `thread.started` — nothing to resume (§2.2).
  if (!acc.sessionId) {
    return { done: false, error: "codex run produced no thread.started event (died before session start)" };
  }
  return { done: false, error: "codex run produced no turn.completed/turn.failed event" };
}
