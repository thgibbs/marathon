import { describe, expect, it } from "vitest";
import { convertManifestCode, parseManifestConversion } from "../src/manifest-conversion.js";

const VALID = {
  id: 123,
  slug: "marathon-abc",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "whsec",
  client_id: "Iv1.abc",
  client_secret: "csec",
  html_url: "https://github.com/apps/marathon-abc",
};

describe("parseManifestConversion", () => {
  it("maps a valid conversion response", () => {
    const creds = parseManifestConversion(VALID);
    expect(creds).toEqual({
      appId: 123,
      slug: "marathon-abc",
      pem: VALID.pem,
      webhookSecret: "whsec",
      clientId: "Iv1.abc",
      clientSecret: "csec",
      htmlUrl: "https://github.com/apps/marathon-abc",
    });
  });

  it("rejects non-objects and responses with missing or mistyped fields", () => {
    expect(parseManifestConversion(null)).toBeUndefined();
    expect(parseManifestConversion("nope")).toBeUndefined();
    expect(parseManifestConversion({ ...VALID, id: "123" })).toBeUndefined();
    expect(parseManifestConversion({ ...VALID, pem: undefined })).toBeUndefined();
    expect(parseManifestConversion({ ...VALID, webhook_secret: null })).toBeUndefined();
  });
});

describe("convertManifestCode", () => {
  it("POSTs the code to the conversions endpoint and parses the credentials", async () => {
    let calledUrl = "";
    let calledMethod = "";
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledMethod = init?.method ?? "GET";
      return Promise.resolve(new Response(JSON.stringify(VALID), { status: 201 }));
    }) as typeof fetch;
    const creds = await convertManifestCode("one time/code", fetchFn);
    expect(calledUrl).toBe("https://api.github.com/app-manifests/one%20time%2Fcode/conversions");
    expect(calledMethod).toBe("POST");
    expect(creds.slug).toBe("marathon-abc");
  });

  it("throws on a non-201 status (expired or already-redeemed code)", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))) as typeof fetch;
    await expect(convertManifestCode("stale", fetchFn)).rejects.toThrow(/HTTP 404/);
  });

  it("throws when the response body has an unexpected shape", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }))) as typeof fetch;
    await expect(convertManifestCode("code", fetchFn)).rejects.toThrow(/unexpected shape/);
  });
});
