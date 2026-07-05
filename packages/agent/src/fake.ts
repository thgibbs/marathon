import { computeCostUsd, parseModelRef, type ModelSpec } from "@marathon/model-gateway";
import type { AgentRuntime, AgentTurn, AgentTurnContext } from "./types";

export interface FakeTurnSpec {
  text: string;
  /** Ask the user this clarifying question: the turn ends in a durable wait (Track 12). */
  ask?: string;
  /**
   * Deterministic stand-in for the model's tool calls this turn (§2b #16):
   * runs (awaited) before the turn returns, with the full turn context —
   * demos/tests use it to call the Tool Gateway exactly the way the real
   * agent would (e.g. submit a document via `document.create`).
   */
  act?: (ctx: AgentTurnContext) => Promise<void> | void;
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
    if (turn.act) await turn.act(ctx);
    const inputTokens = turn.inputTokens ?? 10;
    const outputTokens = turn.outputTokens ?? 5;
    // model ref is honored for provider/model labelling; pricing uses the fake spec
    const { provider, model } = parseModelRef(ctx.request.modelRef || "fake:echo");
    return {
      text: turn.text,
      // A clarifying question ends the turn in a durable wait, never `done`.
      done: turn.ask ? false : i >= this.turns.length - 1,
      waiting: turn.ask ? { question: turn.ask } : undefined,
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
