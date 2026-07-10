import { describe, expect, it } from "vitest";
import { createSmeeChannel } from "../src/smee.js";

describe("createSmeeChannel", () => {
  it("returns the channel URL from the redirect Location", async () => {
    const fetchFn = ((url: string | URL | Request) => {
      expect(String(url)).toBe("https://smee.io/new");
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://smee.io/AbC123" } }),
      );
    }) as typeof fetch;
    await expect(createSmeeChannel(fetchFn)).resolves.toBe("https://smee.io/AbC123");
  });

  it("throws when smee does not answer with a redirect", async () => {
    const fetchFn = (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch;
    await expect(createSmeeChannel(fetchFn)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the Location is not a smee channel", async () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }),
      )) as typeof fetch;
    await expect(createSmeeChannel(fetchFn)).rejects.toThrow();
  });
});
