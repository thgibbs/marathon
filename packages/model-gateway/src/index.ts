import type { SecretStore } from "@marathon/config";

/**
 * Minimal model gateway (design.md §9.2 / §13): model specs + cost computation +
 * routing + per-tenant key resolution. The actual model call is performed by the
 * agent runtime (Pi or the fake); this layer just routes and prices.
 */

/** Cost per 1,000,000 tokens, in USD. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSpec {
  provider: string;
  model: string;
  cost: ModelCost;
  contextWindow?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Role -> "provider:model" mapping (design.md §7.10). */
export interface ModelPolicy {
  default: string;
  [role: string]: string;
}

/** Illustrative default specs. Costs are configurable/overridable per deployment. */
export const BUILTIN_MODELS: ModelSpec[] = [
  { provider: "anthropic", model: "claude-sonnet", cost: { input: 3, output: 15 }, contextWindow: 200_000 },
  { provider: "anthropic", model: "claude-haiku", cost: { input: 0.8, output: 4 }, contextWindow: 200_000 },
  { provider: "openai", model: "gpt-4o", cost: { input: 2.5, output: 10 }, contextWindow: 128_000 },
  { provider: "openai", model: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 }, contextWindow: 128_000 },
];

export function modelRef(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new Error(`invalid model ref: ${ref} (expected "provider:model")`);
  }
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

/** Resolve a role to a model ref, falling back to the policy default. */
export function resolveModelRef(policy: ModelPolicy, role = "default"): string {
  return policy[role] ?? policy.default;
}

/** Cost of a model call from token usage. Same formula across providers (incl. OpenRouter). */
export function computeCostUsd(spec: ModelSpec, usage: ModelUsage): number {
  const { input, output, cacheRead = 0, cacheWrite = 0 } = spec.cost;
  const cost =
    (usage.inputTokens ?? 0) * input +
    (usage.outputTokens ?? 0) * output +
    (usage.cacheReadTokens ?? 0) * cacheRead +
    (usage.cacheWriteTokens ?? 0) * cacheWrite;
  return cost / 1_000_000;
}

export class ModelRegistry {
  private readonly specs = new Map<string, ModelSpec>();

  constructor(specs: ModelSpec[] = BUILTIN_MODELS) {
    for (const s of specs) this.register(s);
  }

  register(spec: ModelSpec): void {
    this.specs.set(modelRef(spec), spec);
  }

  get(ref: string): ModelSpec | undefined {
    return this.specs.get(ref);
  }

  require(ref: string): ModelSpec {
    const spec = this.get(ref);
    if (!spec) throw new Error(`unknown model: ${ref}`);
    return spec;
  }
}

/** Resolve a provider's API key from the secret store (per-tenant injection point). */
export async function resolveApiKey(
  secrets: SecretStore,
  provider: string,
): Promise<string | undefined> {
  return secrets.get(`secret/${provider}`);
}
