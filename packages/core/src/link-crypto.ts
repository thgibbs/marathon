/**
 * Identity-linking primitives (§7.20 / §2b #10): the single-use signed link
 * URL and the at-rest encryption for per-user OAuth tokens. Both key off the
 * deployment master secret (`MARATHON_SECRET_KEY`) — shared by the Slack app
 * (mints the URL) and the GitHub app (verifies it at the OAuth endpoints).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Derive a 32-byte key from the deployment master secret. */
function deriveKey(masterSecret: string, purpose: string): Buffer {
  return createHash("sha256").update(`marathon:${purpose}:${masterSecret}`).digest();
}

/**
 * Encrypt a small secret (a user-to-server token) for at-rest storage —
 * AES-256-GCM, output `enc:v1:<iv>:<ciphertext>:<tag>` (base64url). Stored in
 * `user_identity.credential_ref`; only a process holding the master secret
 * can recover it.
 */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterSecret, "secret"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${ct.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
}

/** Decrypt an {@link encryptSecret} blob; throws on tampering or a wrong key. */
export function decryptSecret(blob: string, masterSecret: string): string {
  const parts = blob.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("not an enc:v1 secret blob");
  }
  const [, , ivB64, ctB64, tagB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterSecret, "secret"), Buffer.from(ivB64!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * What a link token binds (§7.20): the Slack identity is PROVEN by the
 * authenticated (Socket Mode) interaction that minted the URL; the token
 * carries that proof to the OAuth callback. `nonce` is burned at redemption
 * (single-use); `expiresAt` bounds the window (ms since epoch).
 */
export interface LinkTokenPayload {
  tenantId: string;
  slackUserId: string;
  nonce: string;
  expiresAt: number;
}

export function mintLinkToken(payload: LinkTokenPayload, masterSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", deriveKey(masterSecret, "link")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verify signature + expiry; null on any failure (never throws on bad input). */
export function verifyLinkToken(token: string, masterSecret: string, now = Date.now()): LinkTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", deriveKey(masterSecret, "link")).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LinkTokenPayload;
    if (
      typeof payload.tenantId !== "string" ||
      typeof payload.slackUserId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }
    if (payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
