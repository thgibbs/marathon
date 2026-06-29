/** Error classification + retry backoff for the durable queue. */

const TRANSIENT_PATTERN =
  /(timeout|etimedout|econnreset|econnrefused|enotfound|rate.?limit|429|temporarily|throttl|overloaded|503|502|504)/i;

export function classifyError(err: unknown): "transient" | "permanent" {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERN.test(msg) ? "transient" : "permanent";
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: boolean;
}

/** Exponential backoff for a given (1-based) attempt number. */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const raw = Math.min(max, base * Math.pow(factor, Math.max(0, attempt - 1)));
  if (!opts.jitter) return Math.round(raw);
  // full jitter in [raw/2, raw]
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}
