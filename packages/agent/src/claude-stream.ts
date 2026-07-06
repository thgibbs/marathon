import type { ModelSpec } from "@marathon/model-gateway";
import { computeCostUsd } from "@marathon/model-gateway";
import type { AgentProgressEvent } from "./types";

/**
 * Pure parsing of Claude Code's `--output-format stream-json` events
 * (claude-code-impl.md §4.2). Kept separate from the runtime so the mapping —
 * events → progress/usage/result → {@link AgentTurn} — is unit-testable with no
 * process, container, or CLI. Field sets beyond `session_id`/`subtype` are
 * treated as informational (verify-on-pin, §10.4).
 */

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResultEvent {
  type: "result";
  /** "success" | "error_max_turns" | "error_during_execution" | … */
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  num_turns?: number;
  session_id?: string;
  duration_api_ms?: number;
  duration_ms?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClaudeEvent = { type: string; [k: string]: any };

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

/** Parse one stream-json line; returns null for blank/malformed lines (skipped, not fatal). */
export function parseStreamJsonLine(line: string): ClaudeEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && typeof v.type === "string" ? (v as ClaudeEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Incremental accumulator over the stream. The runtime feeds each parsed event
 * as it arrives so per-message usage is available for a mid-invocation budget
 * kill (§4.3) before the terminal `result` event lands.
 */
export class ClaudeStreamAccumulator {
  sessionId?: string;
  /** Streamed assistant text (fallback for `result.result`, which is the final text). */
  streamedText = "";
  result?: ClaudeResultEvent;
  tools: string[] = [];
  mcpServers: { name: string; status: string }[] = [];
  /** Accumulated per-message usage across the invocation's internal turns. */
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  push(event: ClaudeEvent, onEvent?: (ev: AgentProgressEvent) => void): void {
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          if (typeof event.session_id === "string") this.sessionId = event.session_id;
          if (Array.isArray(event.tools)) this.tools = event.tools.map(String);
          if (Array.isArray(event.mcp_servers)) this.mcpServers = event.mcp_servers;
        }
        break;
      case "assistant": {
        const content = event.message?.content ?? [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") this.streamedText += block.text;
            if (block?.type === "tool_use") {
              onEvent?.({ type: "tool_start", toolName: String(block.name ?? ""), summary: cap(safeJson(block.input)) });
            }
          }
        }
        if (event.message?.usage) this.addUsage(event.message.usage);
        break;
      }
      case "user": {
        const content = event.message?.content ?? [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_result") {
              const isError = block.is_error === true;
              onEvent?.({ type: "tool_end", summary: cap(`${isError ? "error" : "ok"}: ${toolResultText(block.content)}`) });
            }
          }
        }
        break;
      }
      case "result":
        this.result = event as ClaudeResultEvent;
        break;
    }
  }

  private addUsage(u: ClaudeUsage): void {
    this.usage.input += u.input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }

  /** Estimated cost from accumulated tokens (for the mid-invocation budget kill, §4.3). */
  estimatedCostUsd(spec: ModelSpec | undefined): number {
    if (!spec) return 0;
    return computeCostUsd(spec, {
      inputTokens: this.usage.input,
      outputTokens: this.usage.output,
      cacheReadTokens: this.usage.cacheRead,
      cacheWriteTokens: this.usage.cacheWrite,
    });
  }

  /** The final assistant text: `result.result` when present, else the streamed text. */
  finalText(): string {
    return this.result?.result ?? this.streamedText;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolResultText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === "string" ? c.text : safeJson(c)))
      .join("");
  }
  return safeJson(content);
}

/** Feed a whole event list through a fresh accumulator (test convenience). */
export function reduceStreamJson(events: ClaudeEvent[], onEvent?: (ev: AgentProgressEvent) => void): ClaudeStreamAccumulator {
  const acc = new ClaudeStreamAccumulator();
  for (const ev of events) acc.push(ev, onEvent);
  return acc;
}

export interface TurnInterpretation {
  /** `success` → the run is done; `error_max_turns` → checkpoint and continue (§2.1). */
  done: boolean;
  /** True when the run stopped on the `--max-turns` cap and should resume next turn. */
  continued: boolean;
  /** A hard model/execution error (not max-turns): the runtime should throw. */
  error?: string;
}

/**
 * Map the terminal `result` event onto done/continue/error (§2.1). `success`
 * completes the harness turn; `error_max_turns` ends it not-done so the runtime
 * checkpoints and resumes with a continuation prompt; any other `is_error` result
 * is a real failure surfaced to the worker.
 */
export function interpretResult(result: ClaudeResultEvent | undefined): TurnInterpretation {
  if (!result) return { done: false, continued: false, error: "claude run produced no result event" };
  if (result.subtype === "success") return { done: true, continued: false };
  if (result.subtype === "error_max_turns") return { done: false, continued: true };
  return {
    done: false,
    continued: false,
    error: `claude run failed (${result.subtype ?? (result.is_error ? "error" : "unknown")})`,
  };
}
