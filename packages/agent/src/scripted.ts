import { computeCostUsd, parseModelRef, type ModelSpec } from "@marathon/model-gateway";
import type {
  AgentRequest,
  AgentRuntime,
  AgentTurn,
  AgentTurnContext,
  AgentWorkspaceBinding,
} from "./types";

/**
 * One scripted harness turn: acts on the task's workspace (edit files, run
 * verify, call governed tools via closures) and returns the turn's assistant
 * text. Deterministic stand-in for a real Pi turn.
 */
export type ScriptedBuildTurn = (ctx: {
  workspace?: AgentWorkspaceBinding;
  request: AgentRequest;
  turnIndex: number;
}) => Promise<string> | string;

/**
 * Thrown to simulate a hard mid-BUILD crash after a turn's checkpoint landed.
 * `name` is "SimulatedCrash" so the worker abandons its lease (no ack/nack),
 * exactly like a real process death — recovered by the next lease.
 */
export class ScriptedCrash extends Error {
  constructor(public readonly afterTurnIndex: number) {
    super(`simulated crash after turn ${afterTurnIndex}`);
    this.name = "SimulatedCrash";
  }
}

export interface ScriptedBuildOptions {
  /** The turn script. The last turn's text is the final answer. */
  turns: ScriptedBuildTurn[];
  /** Test hook: crash (abandon the run) right after this turn's checkpoint persists. */
  crashAfterTurn?: number;
  /** Spec used to price each turn (defaults to a cheap fake model). */
  spec?: ModelSpec;
}

/**
 * Deterministic multi-turn {@link AgentRuntime} for the BUILD stage (K4 tests
 * and demos — no network, no keys). Unlike {@link FakeAgentRuntime}, it runs a
 * real turn *loop* inside one `nextTurn` call, checkpoints after every
 * completed turn via `onTurnCheckpoint`, and resumes from
 * `checkpoint.turnIndex` — the same contract the Pi adapter implements, so the
 * worker's kill/resume machinery is exercised for real.
 */
export class ScriptedBuildRuntime implements AgentRuntime {
  constructor(private readonly opts: ScriptedBuildOptions) {}

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    const { provider, model } = parseModelRef(ctx.request.modelRef || "fake:scripted");
    const spec = this.opts.spec ?? { provider: "fake", model: "scripted", cost: { input: 1, output: 2 } };

    // Resume from the last completed turn — never replay a checkpointed turn.
    const start = (ctx.checkpoint.turnIndex ?? -1) + 1;
    let text = "";
    for (let i = start; i < this.opts.turns.length; i++) {
      const turn = this.opts.turns[i];
      if (!turn) continue;
      text = await turn({ workspace: ctx.workspace, request: ctx.request, turnIndex: i });
      ctx.onEvent?.({ type: "turn_end", summary: `turn ${i} complete` });
      const inputTokens = 10;
      const outputTokens = 5;
      await ctx.onTurnCheckpoint?.({
        turnIndex: i,
        modelInvocation: {
          provider,
          model,
          inputTokens,
          outputTokens,
          costUsd: computeCostUsd(spec, { inputTokens, outputTokens }),
          status: "ok",
        },
      });
      if (this.opts.crashAfterTurn === i) throw new ScriptedCrash(i);
    }
    return { text, done: true, turnIndex: this.opts.turns.length - 1 };
  }
}
