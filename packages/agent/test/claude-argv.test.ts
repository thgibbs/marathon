import { describe, expect, it } from "vitest";
import {
  assertSubscriptionAckIfNeeded,
  claudeArgv,
  claudeSessionHostPath,
  decodeSessionRef,
  disallowedTools,
  encodeSessionRef,
  mcpConfigJson,
  resolveModelAccessEnv,
} from "../src/claude-code";

describe("assertSubscriptionAckIfNeeded (§4.1 — subscription fails closed as dev-only)", () => {
  it("throws when an OAuth token is set without the ack (no proxy)", () => {
    expect(() => assertSubscriptionAckIfNeeded(undefined, "oat", {})).toThrow(/DEV-ONLY/);
    expect(() => assertSubscriptionAckIfNeeded(undefined, "oat", {})).toThrow(/MARATHON_CLAUDE_SUBSCRIPTION_DEV=1/);
  });
  it("passes once the ack is set", () => {
    expect(() =>
      assertSubscriptionAckIfNeeded(undefined, "oat", { MARATHON_CLAUDE_SUBSCRIPTION_DEV: "1" }),
    ).not.toThrow();
  });
  it("is a no-op for api-key mode (no token) and proxy mode (token ignored)", () => {
    expect(() => assertSubscriptionAckIfNeeded(undefined, undefined, {})).not.toThrow();
    expect(() => assertSubscriptionAckIfNeeded("http://proxy", "oat", {})).not.toThrow();
  });
});

describe("resolveModelAccessEnv (model-proxy decision, §4.1)", () => {
  it("PROXY mode: routes through the proxy with a placeholder key (no real key in the container)", () => {
    const env = resolveModelAccessEnv({ proxyBaseUrl: "http://host.docker.internal:8080" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://host.docker.internal:8080");
    expect(env.ANTHROPIC_API_KEY).toBe("marathon-proxy");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("DIRECT mode (bridge default): injects the real key, no ANTHROPIC_BASE_URL", () => {
    const env = resolveModelAccessEnv({ directKey: "sk-ant-real" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toContain(".marathon-home");
  });

  it("proxy WINS when both are present (opt-in proxy hides the key)", () => {
    const env = resolveModelAccessEnv({ proxyBaseUrl: "http://proxy", directKey: "sk-ant-real" });
    expect(env.ANTHROPIC_API_KEY).toBe("marathon-proxy");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy");
  });

  it("locked-down egress REQUIRES the proxy — direct is refused (no other egress)", () => {
    expect(() => resolveModelAccessEnv({ lockedDownEgress: true, directKey: "sk-ant-real" })).toThrow(
      /locked-down egress .* requires the model proxy/,
    );
    // ...but a proxy under locked-down egress is fine.
    expect(() => resolveModelAccessEnv({ lockedDownEgress: true, proxyBaseUrl: "http://proxy" })).not.toThrow();
  });

  it("fails closed when no model credential is configured (API key OR subscription)", () => {
    expect(() => resolveModelAccessEnv({})).toThrow(/needs a model credential/);
  });

  it("SUBSCRIPTION mode: injects CLAUDE_CODE_OAUTH_TOKEN and NO api key / base url", () => {
    const env = resolveModelAccessEnv({ oauthToken: "sk-ant-oat-abc" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-abc");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // an API key would force per-token billing
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("precedence: subscription beats a direct key; proxy beats subscription", () => {
    // oauth over api key.
    const sub = resolveModelAccessEnv({ oauthToken: "oat", directKey: "sk-ant-real" });
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat");
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    // proxy over oauth.
    const px = resolveModelAccessEnv({ proxyBaseUrl: "http://proxy", oauthToken: "oat" });
    expect(px.ANTHROPIC_BASE_URL).toBe("http://proxy");
    expect(px.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("locked-down egress still requires the proxy even with a subscription token", () => {
    expect(() => resolveModelAccessEnv({ lockedDownEgress: true, oauthToken: "oat" })).toThrow(
      /locked-down egress .* requires the model proxy/,
    );
  });
});

describe("disallowedTools (chat-repo.md §3.4)", () => {
  it("always denies Task; adds WebFetch only when egress is locked down", () => {
    expect(disallowedTools({})).toEqual(["Task"]);
    expect(disallowedTools({ lockedDownEgress: true })).toEqual(["Task", "WebFetch"]);
  });

  it("readOnly denies built-in file mutation + shell, leaving reads + governed MCP tools", () => {
    const ro = disallowedTools({ readOnly: true });
    expect(ro).toContain("Bash");
    expect(ro).toContain("Write");
    expect(ro).toContain("Edit");
    expect(ro).toContain("NotebookEdit");
    // Read-side built-ins are NOT denied — grounding needs them.
    expect(ro).not.toContain("Read");
    expect(ro).not.toContain("Grep");
    expect(ro).not.toContain("Glob");
  });

  it("composes with locked-down egress", () => {
    const both = disallowedTools({ readOnly: true, lockedDownEgress: true });
    expect(both).toContain("WebFetch");
    expect(both).toContain("Bash");
  });
});

const base = {
  bin: "claude",
  prompt: "implement the plan",
  model: "claude-sonnet-4-6",
  sessionId: "sess-abc",
  instructions: "You are Forge.",
  mcpConfigPath: "/workspace/.marathon-home/mcp.json",
  disallowedTools: ["Task"],
};

describe("claudeArgv (K7 §11)", () => {
  it("pins the session id on the first turn and resumes thereafter", () => {
    expect(claudeArgv({ ...base, resume: false })).toContain("--session-id");
    expect(claudeArgv({ ...base, resume: false })).not.toContain("--resume");
    const resumed = claudeArgv({ ...base, resume: true });
    expect(resumed).toContain("--resume");
    expect(resumed).not.toContain("--session-id");
  });

  it("sets the required print-mode + hardening flags", () => {
    const argv = claudeArgv({ ...base, resume: false, settingsPath: "/etc/marathon/claude-settings.json" });
    expect(argv.slice(0, 3)).toEqual(["claude", "-p", "implement the plan"]);
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.join(" ")).toContain("--permission-mode bypassPermissions");
    expect(argv.join(" ")).toContain("--disallowedTools Task");
    expect(argv.join(" ")).toContain("--settings /etc/marathon/claude-settings.json");
    // Claude Code 2.x removed --max-turns; Marathon must not emit it (unknown
    // flag → the CLI exits non-zero with no result event).
    expect(argv).not.toContain("--max-turns");
  });

  it("carries no secret material in the argv", () => {
    const argv = claudeArgv({ ...base, resume: false }).join(" ");
    expect(argv).not.toMatch(/sk-ant|api[_-]?key|secret|token/i);
  });

  it("adds a fallback model only when configured", () => {
    expect(claudeArgv({ ...base, resume: false }).join(" ")).not.toContain("--fallback-model");
    expect(claudeArgv({ ...base, resume: false, fallbackModel: "claude-haiku-4-5" }).join(" ")).toContain(
      "--fallback-model claude-haiku-4-5",
    );
  });
});

describe("mcpConfigJson", () => {
  it("wires the stdio shim to the guest broker socket (unix)", () => {
    const cfg = JSON.parse(mcpConfigJson({ socket: "/run/marathon/broker.sock" }, { command: "marathon-mcp-shim" }));
    expect(cfg.mcpServers.marathon).toEqual({
      type: "stdio",
      command: "marathon-mcp-shim",
      args: ["--socket", "/run/marathon/broker.sock"],
    });
  });

  it("wires the shim to a TCP endpoint (macOS Docker Desktop, §3.1)", () => {
    const cfg = JSON.parse(mcpConfigJson({ tcp: "host.docker.internal:54321" }, { command: "marathon-mcp-shim", args: ["tsx", "bin.ts"] }));
    expect(cfg.mcpServers.marathon.args).toEqual(["tsx", "bin.ts", "--tcp", "host.docker.internal:54321"]);
  });
});

describe("session ref + host path (K7 §5)", () => {
  it("round-trips the session pointer, ignoring legacy/plain refs", () => {
    const ref = encodeSessionRef({ sessionId: "s1", snapshot: "/snap/turn-2.jsonl", continued: true });
    expect(decodeSessionRef(ref)).toEqual({ sessionId: "s1", snapshot: "/snap/turn-2.jsonl", continued: true });
    expect(decodeSessionRef(undefined)).toBeUndefined();
    expect(decodeSessionRef("/legacy/path.jsonl")).toBeUndefined();
  });

  it("maps the guest CLAUDE_CONFIG_DIR under the host workspace mount", () => {
    const p = claudeSessionHostPath({ workspaceDir: "/host/ws", sessionId: "s1" });
    expect(p).toBe("/host/ws/.marathon-home/.claude/projects/-workspace/s1.jsonl");
  });
});
