import { computeCostUsd, parseModelRef, type ModelSpec } from "@marathon/model-gateway";
import type { AgentRuntime, AgentTurn, AgentTurnContext } from "./types";

export interface FakeTurnSpec {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FakeAgentOptions {
  /** Scripted turns. The last one is the final answer. */
  turns: FakeTurnSpec[];
  /** Spec used to price each turn (defaults to a cheap fake model). */
  spec?: ModelSpec;
}

/**
 * Deterministic AgentRuntime for tests and CI — no network, no keys. Replays a
 * fixed script of turns, pricing each via the model gateway so cost recording is
 * exercised end-to-end.
 */
export class FakeAgentRuntime implements AgentRuntime {
  private readonly turns: FakeTurnSpec[];
  private readonly spec: ModelSpec;

  constructor(opts: FakeAgentOptions) {
    this.turns = opts.turns;
    this.spec = opts.spec ?? { provider: "fake", model: "echo", cost: { input: 1, output: 2 } };
  }

  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    const i = ctx.checkpoint.completedSteps.length;
    const turn = this.turns[i];
    if (!turn) {
      return { text: "", done: true };
    }
    const inputTokens = turn.inputTokens ?? 10;
    const outputTokens = turn.outputTokens ?? 5;
    // model ref is honored for provider/model labelling; pricing uses the fake spec
    const { provider, model } = parseModelRef(ctx.request.modelRef || "fake:echo");
    return {
      text: turn.text,
      done: i >= this.turns.length - 1,
      modelInvocation: {
        provider,
        model,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(this.spec, { inputTokens, outputTokens }),
        status: "ok",
      },
    };
  }
}
