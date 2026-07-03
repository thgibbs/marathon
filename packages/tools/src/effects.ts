import type { SecretStore } from "@marathon/config";
import type { ProposedEffect } from "@marathon/core";

/**
 * The non-model executor side of Proposed Effects (design §7.9; Track 9).
 * An executor is a plain host-side function keyed by `effect_type`: after a
 * human approves the exact proposal, the executor performs exactly that
 * mutation with credentials the model never held. It is *not* a tool call —
 * the model cannot invoke, retry, or vary it.
 */
export interface EffectExecutorContext {
  /** Credentials resolve here at execution — never through the model. */
  secrets: SecretStore;
}

export interface EffectExecutionResult {
  summary: string;
  details?: Record<string, unknown>;
}

export type EffectExecutor = (
  effect: ProposedEffect,
  ctx: EffectExecutorContext,
) => Promise<EffectExecutionResult>;

/** Registry of executors by effect type (e.g. `github.merge_pull_request`). */
export class EffectExecutorRegistry {
  private readonly executors = new Map<string, EffectExecutor>();

  register(effectType: string, executor: EffectExecutor): void {
    this.executors.set(effectType, executor);
  }

  get(effectType: string): EffectExecutor | undefined {
    return this.executors.get(effectType);
  }
}
