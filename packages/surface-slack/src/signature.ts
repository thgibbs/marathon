import { createHmac, timingSafeEqual } from "node:crypto";

export function computeSlackSignature(signingSecret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

/**
 * Verify a Slack request signature (v0 HMAC-SHA256) and reject stale timestamps
 * (replay protection). `now` is in ms.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
  now: number = Date.now(),
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > 60 * 5) return false; // >5 min skew
  const expected = computeSlackSignature(signingSecret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
