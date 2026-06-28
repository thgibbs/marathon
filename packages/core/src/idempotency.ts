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
