import { createHash } from "node:crypto";

/** Deterministic JSON for hashing (sorted keys). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Idempotency key for an inbound surface event (e.g. a Slack event id). */
export function surfaceEventKey(surfaceType: string, externalEventId: string): string {
  return `surface:${surfaceType}:${externalEventId}`;
}

/** Idempotency key for a tool effect: task + tool + a hash of normalized input. */
export function taskToolInputKey(taskId: string, tool: string, input: unknown): string {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
  return `task:${taskId}:tool:${tool}:${hash}`;
}

/** Backing store for exactly-once execution of side effects. */
export interface IdempotencyStore {
  /** Returns true if the key was newly claimed (caller should run the effect). */
  claim(key: string): Promise<boolean>;
  /** Release a claim so a failed effect can be retried. */
  release?(key: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  async release(key: string): Promise<void> {
    this.seen.delete(key);
  }
}

/**
 * Run `fn` at most once per key. If the key is already claimed, returns
 * `{ executed: false }` without running. On failure the claim is released so a
 * later retry can run.
 */
export async function runOnce<T>(
  store: IdempotencyStore,
  key: string,
  fn: () => Promise<T>,
): Promise<{ executed: boolean; result?: T }> {
  if (!(await store.claim(key))) return { executed: false };
  try {
    return { executed: true, result: await fn() };
  } catch (err) {
    await store.release?.(key);
    throw err;
  }
}
