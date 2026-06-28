import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, runOnce } from "../src/idempotency";

describe("runOnce / idempotency store", () => {
  it("executes only once per key", async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const fn = async () => {
      calls++;
      return "done";
    };
    const a = await runOnce(store, "k", fn);
    const b = await runOnce(store, "k", fn);
    expect(a).toEqual({ executed: true, result: "done" });
    expect(b.executed).toBe(false);
    expect(calls).toBe(1);
  });

  it("releases the claim on failure so a retry can run", async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    await expect(
      runOnce(store, "k", async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // retry succeeds because the claim was released
    const r = await runOnce(store, "k", async () => {
      calls++;
      return "ok";
    });
    expect(r.executed).toBe(true);
    expect(calls).toBe(2);
  });

  it("tracks keys independently", async () => {
    const store = new InMemoryIdempotencyStore();
    expect((await runOnce(store, "a", async () => 1)).executed).toBe(true);
    expect((await runOnce(store, "b", async () => 2)).executed).toBe(true);
    expect((await runOnce(store, "a", async () => 1)).executed).toBe(false);
  });
});
