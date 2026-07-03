import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiSession } from "../src/pi";

/**
 * The K4 resume decision, against the real Pi module (no model calls): a
 * checkpointed sessionRef re-opens that exact snapshot; anything else starts a
 * fresh durable session in the per-task directory.
 */
describe("resolvePiSession (durable Pi session resume, K4)", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");

  it("creates a fresh per-task session when there is no sessionRef", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-"));
    const { sessionManager, resumed } = resolvePiSession(pi, {
      cwd: process.cwd(),
      taskSessionDir: dir,
    });
    expect(resumed).toBe(false);
    expect(sessionManager.getSessionFile()).toContain(dir);
  });

  it("falls back to a fresh session when sessionRef points at a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-"));
    const { resumed } = resolvePiSession(pi, {
      cwd: process.cwd(),
      taskSessionDir: dir,
      sessionRef: join(dir, "no-such-snapshot.jsonl"),
    });
    expect(resumed).toBe(false);
  });

  it("re-opens an existing snapshot with its entries intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-"));
    const sm = pi.SessionManager.create(process.cwd(), dir);
    sm.appendMessage({ role: "user", content: "implement the plan", timestamp: Date.now() });
    // Pi flushes the file once an assistant message lands — i.e. by the first
    // turn_end, which is when the runtime snapshots it.
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      timestamp: Date.now(),
    } as never);
    const file = sm.getSessionFile();
    expect(file && existsSync(file)).toBe(true);

    const { sessionManager, resumed } = resolvePiSession(pi, {
      cwd: process.cwd(),
      taskSessionDir: dir,
      sessionRef: file,
    });
    expect(resumed).toBe(true);
    expect(sessionManager.getEntries()).toHaveLength(2);
  });

  it("uses an in-memory session when no session directory is configured", () => {
    const { sessionManager, resumed } = resolvePiSession(pi, { cwd: process.cwd() });
    expect(resumed).toBe(false);
    expect(sessionManager.getSessionFile()).toBeUndefined();
  });
});
