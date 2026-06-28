import { FakeAgentRuntime, type AgentRequest } from "@marathon/agent";
import { emptyCheckpoint } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { makeAgentStepRunner } from "../src/agent-step";

const request: AgentRequest = {
  taskId: "t1",
  instructions: "be brief",
  input: "hello",
  modelRef: "anthropic:claude-haiku",
};

describe("makeAgentStepRunner (Pi-turn -> TaskStep mapping)", () => {
  it("maps each turn to a turn:N step and records a model invocation", async () => {
    const rt = new FakeAgentRuntime({ turns: [{ text: "a" }, { text: "b" }] });
    const run = makeAgentStepRunner(rt, request);

    const r0 = await run({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(r0.stepType).toBe("turn:0");
    expect(r0.checkpoint.completedSteps).toEqual(["turn:0"]);
    expect(r0.checkpoint.findings).toEqual(["a"]);
    expect(r0.done).toBe(false);
    expect(r0.modelInvocations).toHaveLength(1);
    expect(r0.modelInvocations?.[0]?.provider).toBe("anthropic");

    // resume from the prior checkpoint -> next turn
    const r1 = await run({ taskId: "t1", checkpoint: r0.checkpoint });
    expect(r1.stepType).toBe("turn:1");
    expect(r1.done).toBe(true);
  });

  it("redacts secrets from findings by default, and can be toggled off", async () => {
    const secretText = "token sk-abcdef0123456789ABCDEF";
    const rt = new FakeAgentRuntime({ turns: [{ text: secretText }] });

    const redacted = await makeAgentStepRunner(rt, request)({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(redacted.checkpoint.findings[0]).toContain("[REDACTED]");

    const raw = await makeAgentStepRunner(rt, request, { redactTrace: false })({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(raw.checkpoint.findings[0]).toContain("sk-abcdef");
  });
});
