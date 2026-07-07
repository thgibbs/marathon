import { describe, expect, it } from "vitest";
import { brokerConnectArg } from "../src/connect";

describe("brokerConnectArg (§3.1 — unix socket or TCP transport)", () => {
  it("parses a unix socket path", () => {
    expect(brokerConnectArg(["--socket", "/run/marathon/broker.sock"])).toEqual({ path: "/run/marathon/broker.sock" });
    expect(brokerConnectArg(["--socket=/tmp/b.sock"])).toEqual({ path: "/tmp/b.sock" });
  });

  it("parses a TCP host:port (macOS Docker Desktop)", () => {
    expect(brokerConnectArg(["--tcp", "host.docker.internal:54321"])).toEqual({
      host: "host.docker.internal",
      port: 54321,
    });
    expect(brokerConnectArg(["--tcp=127.0.0.1:8080"])).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  it("prefers --tcp when both are present", () => {
    expect(brokerConnectArg(["--socket", "/s.sock", "--tcp", "h:1"])).toEqual({ host: "h", port: 1 });
  });

  it("throws on a bad --tcp and when neither is given", () => {
    expect(() => brokerConnectArg(["--tcp", "no-port"])).toThrow(/host:port/);
    expect(() => brokerConnectArg([])).toThrow(/--socket .* or --tcp/);
  });
});
