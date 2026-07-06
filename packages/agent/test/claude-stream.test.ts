import { describe, expect, it } from "vitest";
import {
  ClaudeStreamAccumulator,
  interpretResult,
  parseStreamJsonLine,
  reduceStreamJson,
} from "../src/claude-stream";
import type { AgentProgressEvent } from "../src/types";

const SPEC = { provider: "anthropic", model: "claude-sonnet-4-6", cost: { input: 3, output: 15 } };

describe("stream-json reducer (K7 §4.2)", () => {
  it("captures the session id from system:init", () => {
    const acc = reduceStreamJson([{ type: "system", subtype: "init", session_id: "sess-123", tools: ["Bash"], mcp_servers: [{ name: "marathon", status: "connected" }] }]);
    expect(acc.sessionId).toBe("sess-123");
    expect(acc.tools).toEqual(["Bash"]);
    expect(acc.mcpServers).toEqual([{ name: "marathon", status: "connected" }]);
  });

  it("accumulates per-message usage across internal turns and emits tool progress", () => {
    const events: AgentProgressEvent[] = [];
    const acc = reduceStreamJson(
      [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 100, output_tokens: 10 } } },
        { type: "user", message: { content: [{ type: "tool_result", content: "a.ts\nb.ts" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 50, output_tokens: 5 } } },
      ],
      (ev) => events.push(ev),
    );
    expect(acc.usage.input).toBe(150);
    expect(acc.usage.output).toBe(15);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end"]);
    expect(events[0]?.toolName).toBe("Bash");
    // estimated cost: (150*3 + 15*15)/1e6
    expect(acc.estimatedCostUsd(SPEC)).toBeCloseTo((150 * 3 + 15 * 15) / 1_000_000, 10);
  });

  it("prefers result.result for the final text, falling back to streamed text", () => {
    const acc = reduceStreamJson([
      { type: "assistant", message: { content: [{ type: "text", text: "streamed" }] } },
      { type: "result", subtype: "success", result: "final answer", session_id: "s", total_cost_usd: 0.02, usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(acc.finalText()).toBe("final answer");

    const noResultText = new ClaudeStreamAccumulator();
    noResultText.push({ type: "assistant", message: { content: [{ type: "text", text: "streamed only" }] } });
    expect(noResultText.finalText()).toBe("streamed only");
  });

  it("skips blank and malformed lines without throwing", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("not json")).toBeNull();
    expect(parseStreamJsonLine('{"no":"type"}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"result","subtype":"success"}')?.type).toBe("result");
  });

  it("maps result subtypes to done / continue / error (§2.1)", () => {
    expect(interpretResult({ type: "result", subtype: "success" })).toEqual({ done: true, continued: false });
    expect(interpretResult({ type: "result", subtype: "error_max_turns" })).toEqual({ done: false, continued: true });
    const err = interpretResult({ type: "result", subtype: "error_during_execution", is_error: true });
    expect(err.done).toBe(false);
    expect(err.error).toContain("error_during_execution");
    expect(interpretResult(undefined).error).toBeTruthy();
  });
});
