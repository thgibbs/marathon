import { describe, expect, it } from "vitest";
import { injectAuthHeaders, isAllowedAnthropicPath, parseUsageFromAnthropicResponse } from "../src/proxy";

describe("AnthropicKeyProxy pure helpers (K7 §4.1)", () => {
  it("allows only Anthropic API paths", () => {
    expect(isAllowedAnthropicPath("/v1/messages")).toBe(true);
    expect(isAllowedAnthropicPath("/v1/messages/count_tokens")).toBe(true);
    expect(isAllowedAnthropicPath("/v1/models")).toBe(true);
    expect(isAllowedAnthropicPath("/v1/organizations/keys")).toBe(false);
    expect(isAllowedAnthropicPath("/../etc/passwd")).toBe(false);
    expect(isAllowedAnthropicPath("/")).toBe(false);
  });

  it("strips client auth and injects the real per-tenant key", () => {
    const out = injectAuthHeaders(
      {
        authorization: "Bearer marathon-proxy",
        "x-api-key": "marathon-proxy",
        host: "proxy:8080",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      "sk-ant-REAL-TENANT-KEY",
    );
    // The placeholder never reaches upstream; the real key is set; host/hop headers dropped.
    expect(out["x-api-key"]).toBe("sk-ant-REAL-TENANT-KEY");
    expect(out.authorization).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(out)).not.toContain("marathon-proxy");
  });

  it("meters usage from an Anthropic message response (backstop)", () => {
    const usage = parseUsageFromAnthropicResponse(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10 },
      }),
    );
    expect(usage).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: undefined,
    });
  });

  it("returns undefined for streamed/non-JSON bodies", () => {
    expect(parseUsageFromAnthropicResponse("event: message_start\n")).toBeUndefined();
    expect(parseUsageFromAnthropicResponse("{}")).toBeUndefined();
  });
});
