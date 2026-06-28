import { emptyCheckpoint } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../src/fake";
import type { AgentRequest } from "../src/types";

const request: AgentRequest = {
  taskId: "t1",
  instructions: "be brief",
  input: "hello",
  modelRef: "anthropic:claude-haiku",
};

describe("FakeAgentRuntime", () => {
  it("replays scripted turns and prices each", async () => {
    const rt = new FakeAgentRuntime({
      turns: [
        { text: "thinking...", inputTokens: 100, outputTokens: 20 },
        { text: "hello world", inputTokens: 50, outputTokens: 10 },
      ],
    });

    const t0 = await rt.nextTurn({ request, checkpoint: emptyCheckpoint() });
    expect(t0.text).toBe("thinking...");
    expect(t0.done).toBe(false);
    expect(t0.modelInvocation?.provider).toBe("anthropic");
    expect(t0.modelInvocation?.model).toBe("claude-haiku");
    expect(t0.modelInvocation?.costUsd).toBeGreaterThan(0);

    const t1 = await rt.nextTurn({
      request,
      checkpoint: { completedSteps: ["turn:0"], findings: ["thinking..."] },
    });
    expect(t1.text).toBe("hello world");
    expect(t1.done).toBe(true);
  });

  it("is done once the script is exhausted", async () => {
    const rt = new FakeAgentRuntime({ turns: [{ text: "only" }] });
    const after = await rt.nextTurn({
      request,
      checkpoint: { completedSteps: ["turn:0"], findings: ["only"] },
    });
    expect(after.done).toBe(true);
    expect(after.text).toBe("");
  });
});
