import { createHmac, timingSafeEqual } from "node:crypto";

export function computeGithubSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Verify a GitHub webhook signature (X-Hub-Signature-256). */
export function verifyGithubSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = computeGithubSignature(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
