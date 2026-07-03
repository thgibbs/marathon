import { emptyCheckpoint } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { ScriptedBuildRuntime, ScriptedCrash } from "../src/scripted";
import type { AgentRequest, AgentTurnCheckpoint } from "../src/types";

const request: AgentRequest = {
  taskId: "t1",
  instructions: "build it",
  input: "implement the plan",
  modelRef: "fake:scripted",
};

describe("ScriptedBuildRuntime (multi-turn BUILD loop, K4 contract)", () => {
  it("runs all turns in one call, checkpointing after each", async () => {
    const seen: AgentTurnCheckpoint[] = [];
    const rt = new ScriptedBuildRuntime({
      turns: [() => "one", () => "two", () => "three"],
    });
    const turn = await rt.nextTurn({
      request,
      checkpoint: emptyCheckpoint(),
      onTurnCheckpoint: (cp) => void seen.push(cp),
    });
    expect(turn.done).toBe(true);
    expect(turn.text).toBe("three");
    expect(turn.turnIndex).toBe(2);
    expect(seen.map((c) => c.turnIndex)).toEqual([0, 1, 2]);
    expect(seen[0]?.modelInvocation?.provider).toBe("fake");
  });

  it("resumes from checkpoint.turnIndex without replaying completed turns", async () => {
    const ran: number[] = [];
    const rt = new ScriptedBuildRuntime({
      turns: [
        ({ turnIndex }) => (ran.push(turnIndex), "a"),
        ({ turnIndex }) => (ran.push(turnIndex), "b"),
        ({ turnIndex }) => (ran.push(turnIndex), "c"),
      ],
    });
    const turn = await rt.nextTurn({
      request,
      checkpoint: { ...emptyCheckpoint(), turnIndex: 0 },
    });
    expect(ran).toEqual([1, 2]);
    expect(turn.done).toBe(true);
  });

  it("crashAfterTurn throws AFTER that turn's checkpoint landed, as a SimulatedCrash", async () => {
    const seen: number[] = [];
    const rt = new ScriptedBuildRuntime({
      turns: [() => "a", () => "b", () => "c"],
      crashAfterTurn: 1,
    });
    const err = await rt
      .nextTurn({
        request,
        checkpoint: emptyCheckpoint(),
        onTurnCheckpoint: (cp) => void seen.push(cp.turnIndex),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ScriptedCrash);
    expect((err as Error).name).toBe("SimulatedCrash");
    expect(seen).toEqual([0, 1]); // turn 1's checkpoint persisted before the crash
  });

  it("a failing checkpoint sink fails the run (no progress past an unpersisted turn)", async () => {
    const rt = new ScriptedBuildRuntime({ turns: [() => "a", () => "b"] });
    await expect(
      rt.nextTurn({
        request,
        checkpoint: emptyCheckpoint(),
        onTurnCheckpoint: () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
  });
});
