import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, mintLinkToken, verifyLinkToken } from "../src/link-crypto";

const KEY = "test-master-secret";

describe("encryptSecret / decryptSecret (§2b #10 — token at rest)", () => {
  it("round-trips and never stores plaintext", () => {
    const blob = encryptSecret("ghu_usertoken123", KEY);
    expect(blob).toMatch(/^enc:v1:/);
    expect(blob).not.toContain("ghu_usertoken123");
    expect(decryptSecret(blob, KEY)).toBe("ghu_usertoken123");
  });

  it("fresh iv per encryption — same plaintext, different blobs", () => {
    expect(encryptSecret("x", KEY)).not.toBe(encryptSecret("x", KEY));
  });

  it("rejects tampering and a wrong key", () => {
    const blob = encryptSecret("secret", KEY);
    const parts = blob.split(":");
    parts[3] = Buffer.from("tampered!").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), KEY)).toThrow();
    expect(() => decryptSecret(blob, "other-key")).toThrow();
    expect(() => decryptSecret("not-a-blob", KEY)).toThrow(/enc:v1/);
  });
});

describe("mintLinkToken / verifyLinkToken (§2b #10 — the signed single-use URL)", () => {
  const payload = { tenantId: "tn1", slackUserId: "U123", nonce: "n-1", expiresAt: Date.now() + 60_000 };

  it("round-trips a valid token", () => {
    const token = mintLinkToken(payload, KEY);
    expect(verifyLinkToken(token, KEY)).toEqual(payload);
  });

  it("rejects a tampered payload (the binding is the point)", () => {
    const token = mintLinkToken(payload, KEY);
    const [body, mac] = token.split(".");
    const forged = JSON.parse(Buffer.from(body!, "base64url").toString());
    forged.slackUserId = "U-attacker";
    const forgedToken = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
    expect(verifyLinkToken(forgedToken, KEY)).toBeNull();
  });

  it("rejects a wrong signing key, expiry, and malformed input — without throwing", () => {
    const token = mintLinkToken(payload, KEY);
    expect(verifyLinkToken(token, "other-key")).toBeNull();
    expect(verifyLinkToken(token, KEY, payload.expiresAt + 1)).toBeNull();
    expect(verifyLinkToken("garbage", KEY)).toBeNull();
    expect(verifyLinkToken("a.b", KEY)).toBeNull();
    expect(verifyLinkToken("", KEY)).toBeNull();
  });
});
