import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact";

describe("redactSecrets", () => {
  it("masks api-key-like tokens by default", () => {
    const out = redactSecrets("key=sk-abcdef0123456789ABCDEF done");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-abcdef0123456789ABCDEF");
  });

  it("masks slack and github tokens", () => {
    expect(redactSecrets("xoxb-1234567890-abcdEFGH")).toContain("[REDACTED]");
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  it("can be toggled off", () => {
    const raw = "key=sk-abcdef0123456789ABCDEF";
    expect(redactSecrets(raw, { enabled: false })).toBe(raw);
  });

  it("leaves ordinary text unchanged", () => {
    expect(redactSecrets("just some findings")).toBe("just some findings");
  });
});
