import { describe, expect, it } from "vitest";
import {
  CodexStreamAccumulator,
  interpretResult,
  parseStreamJsonLine,
  readUsage,
  reduceStreamJson,
} from "../src/codex-stream";
import type { AgentProgressEvent } from "../src/types";

const SPEC = { provider: "openai", model: "gpt-5-codex", cost: { input: 3, output: 15 } };

describe("codex JSONL reducer (K8 §2.2/§4.2)", () => {
  it("captures the session id from thread.started (§2.2)", () => {
    const acc = reduceStreamJson([{ type: "thread.started", thread_id: "th-123" }]);
    expect(acc.sessionId).toBe("th-123");
    // Also accepts session_id / id shapes defensively.
    expect(reduceStreamJson([{ type: "thread.started", session_id: "s2" }]).sessionId).toBe("s2");
    expect(reduceStreamJson([{ type: "thread.started", id: "i3" }]).sessionId).toBe("i3");
  });

  it("maps item.started/completed to tool progress; agent messages are not tools", () => {
    const events: AgentProgressEvent[] = [];
    reduceStreamJson(
      [
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.started", item: { item_type: "command_execution", command: "ls -la" } },
        { type: "item.completed", item: { item_type: "command_execution", command: "ls -la" } },
        // An agent message must NOT surface as a tool event.
        { type: "item.completed", item: { item_type: "agent_message", text: "hi" } },
      ],
      (ev) => events.push(ev),
    );
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end"]);
    expect(events[0]?.toolName).toBe("command");
    expect(events[0]?.summary).toContain("ls -la");
  });

  it("accumulates the final agent message text, falling back to streamed items", () => {
    const withFinal = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { item_type: "agent_message", text: "streamed" } },
      { type: "turn.completed", agent_message: "final answer", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(withFinal.finalText()).toBe("final answer");

    const streamedOnly = new CodexStreamAccumulator();
    streamedOnly.push({ type: "item.completed", item: { item_type: "agent_message", text: "only streamed" } });
    streamedOnly.push({ type: "turn.completed", usage: {} });
    expect(streamedOnly.finalText()).toBe("only streamed");
  });

  it("skips blank and malformed lines without throwing", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("not json")).toBeNull();
    expect(parseStreamJsonLine('{"no":"type"}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"turn.completed"}')?.type).toBe("turn.completed");
  });

  it("parses usage defensively: flat and token_usage-nested shapes; missing → undefined, never NaN (§4.3)", () => {
    expect(readUsage({ input_tokens: 100, output_tokens: 20 })).toEqual({ input: 100, output: 20, cached: undefined });
    expect(readUsage({ token_usage: { input_tokens: 5, output_tokens: 2 } })).toEqual({ input: 5, output: 2, cached: undefined });
    expect(readUsage(undefined)).toEqual({});
    // A garbage value coerces to undefined, not NaN.
    expect(readUsage({ input_tokens: Number.NaN as unknown as number })).toEqual({ input: undefined, output: undefined, cached: undefined });
  });

  it("accumulates usage from turn.completed and estimates cost", () => {
    const acc = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.completed", agent_message: "ok", usage: { input_tokens: 100, output_tokens: 20 } },
    ]);
    expect(acc.usage.input).toBe(100);
    expect(acc.usage.output).toBe(20);
    expect(acc.estimatedCostUsd(SPEC)).toBeCloseTo((100 * 3 + 20 * 15) / 1_000_000, 10);
  });

  it("flags per-event usage seen BEFORE the terminal event (gates the mid-turn kill, §4.3)", () => {
    const withMidUsage = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { item_type: "agent_message", text: "x", usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "turn.completed", agent_message: "ok", usage: { input_tokens: 5, output_tokens: 1 } },
    ]);
    expect(withMidUsage.sawUsageBeforeTerminal).toBe(true);

    const noMidUsage = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
    ]);
    expect(noMidUsage.sawUsageBeforeTerminal).toBe(false);
  });

  it("never double-counts: terminal usage is authoritative over pre-terminal per-item usage (§4.3)", () => {
    // Per-item usage (100/20) powers the mid-turn kill; turn.completed then
    // reports the invocation TOTAL (150/30). Summing both would over-record
    // ModelInvocation.costUsd and trip the next turn's budget check early —
    // the terminal total must win outright.
    const acc = new CodexStreamAccumulator();
    acc.push({ type: "thread.started", thread_id: "t" });
    acc.push({ type: "item.completed", item: { item_type: "agent_message", text: "x", usage: { input_tokens: 100, output_tokens: 20 } } });
    // Mid-stream (no terminal yet): the budget-kill estimate sees the live accumulation.
    expect(acc.usage).toEqual({ input: 100, output: 20, cached: 0 });
    acc.push({ type: "turn.completed", agent_message: "ok", usage: { input_tokens: 150, output_tokens: 30 } });
    expect(acc.usage).toEqual({ input: 150, output: 30, cached: 0 });
    expect(acc.estimatedCostUsd(SPEC)).toBeCloseTo((150 * 3 + 30 * 15) / 1_000_000, 10);
  });

  it("falls back to the pre-terminal accumulation when turn.completed carries no usage (§4.3)", () => {
    const acc = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { item_type: "agent_message", text: "x", usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "item.completed", item: { item_type: "agent_message", text: "y", usage: { input_tokens: 7, output_tokens: 2 } } },
      { type: "turn.completed", agent_message: "ok", usage: {} },
    ]);
    expect(acc.usage).toEqual({ input: 17, output: 3, cached: 0 });
  });

  it("interprets turn.completed as done, turn.failed as not-done+error (§2.2)", () => {
    const done = reduceStreamJson([{ type: "thread.started", thread_id: "t" }, { type: "turn.completed", usage: {} }]);
    expect(interpretResult(done)).toEqual({ done: true });

    const failed = reduceStreamJson([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.failed", error: { message: "model overloaded" } },
    ]);
    const fi = interpretResult(failed);
    expect(fi.done).toBe(false);
    expect(fi.error).toContain("model overloaded");
  });

  it("detects 'died before thread.started' (no session id captured, §2.2)", () => {
    const died = reduceStreamJson([]); // process produced nothing
    const r = interpretResult(died);
    expect(r.done).toBe(false);
    expect(r.error).toMatch(/died before session start|no thread.started/);
    expect(died.sessionId).toBeUndefined();
  });

  it("no terminal but a session id → not-done with a distinct error", () => {
    const partial = reduceStreamJson([{ type: "thread.started", thread_id: "t" }]);
    const r = interpretResult(partial);
    expect(r.done).toBe(false);
    expect(r.error).toContain("no turn.completed/turn.failed");
  });
});
