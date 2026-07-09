import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCodexSubscriptionAckIfNeeded,
  codexArgv,
  codexConfigHostPath,
  codexConfigToml,
  codexSessionHostPath,
  resolveCodexModelAccessEnv,
  stageCodexSubscriptionAuthJson as stageSubscriptionAuthJson,
  writeCodexConfigAtomic,
} from "../src/index";

describe("codexArgv (K8 §11)", () => {
  const base = { bin: "codex", prompt: "implement the plan", model: "gpt-5-codex" };

  it("first turn: exec --json <prompt> --sandbox workspace-write --ask-for-approval never --model --cd", () => {
    const argv = codexArgv(base);
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    // No resume subcommand on the first turn; prompt is positional after --json.
    expect(argv).not.toContain("resume");
    expect(argv[3]).toBe("implement the plan");
    expect(argv.join(" ")).toContain("--sandbox workspace-write");
    expect(argv.join(" ")).toContain("--ask-for-approval never");
    expect(argv.join(" ")).toContain("--model gpt-5-codex");
    expect(argv.join(" ")).toContain("--cd /workspace");
  });

  it("resume: `resume <sid>` is a subcommand right after exec, prompt after it (§2.1)", () => {
    const argv = codexArgv({ ...base, resumeSessionId: "sess-xyz" });
    const ex = argv.indexOf("exec");
    expect(argv[ex + 1]).toBe("--json");
    expect(argv[ex + 2]).toBe("resume");
    expect(argv[ex + 3]).toBe("sess-xyz");
    expect(argv[ex + 4]).toBe("implement the plan");
  });

  it("readOnly maps to --sandbox read-only (§3.3)", () => {
    expect(codexArgv({ ...base, readOnly: true }).join(" ")).toContain("--sandbox read-only");
    expect(codexArgv({ ...base, readOnly: true }).join(" ")).not.toContain("workspace-write");
  });

  it("never passes --ephemeral (durable sessions are the point, §5.2)", () => {
    expect(codexArgv({ ...base, resumeSessionId: "s" })).not.toContain("--ephemeral");
    expect(codexArgv(base)).not.toContain("--ephemeral");
  });

  it("carries no secret material in the argv (§4.1)", () => {
    const argv = codexArgv({ ...base, resumeSessionId: "sess-xyz", model: "gpt-5-codex", prompt: "do the thing" }).join(" ");
    // "--ask-for-approval" incidentally contains "sk-", so anchor on real key shapes.
    expect(argv).not.toMatch(/\bsk-[a-z]|api[_-]?key|CODEX_API_KEY/i);
  });
});

describe("codexConfigToml (§3.1)", () => {
  it("writes the governed MCP server with required, timeout, approve mode (socket transport)", () => {
    const toml = codexConfigToml({
      shimCommand: "marathon-mcp-shim",
      connect: { socket: "/run/marathon/broker.sock" },
      token: "cap-tok",
      instructions: "You are Forge.",
    });
    expect(toml).toContain("[mcp_servers.marathon]");
    expect(toml).toContain('command = "marathon-mcp-shim"');
    expect(toml).toContain('args = ["--socket", "/run/marathon/broker.sock", "--token", "cap-tok"]');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).toContain("required = true");
    expect(toml).toContain("startup_timeout_sec = 20");
    expect(toml).toContain('developer_instructions = "You are Forge."');
    expect(toml).toContain('[projects."/workspace"]');
    expect(toml).toContain('trust_level = "untrusted"');
    // developer_instructions must be TOP-LEVEL: in TOML, a bare `key = value`
    // after a table header belongs to that table, so it must precede the first
    // `[…]` header or Codex sees mcp_servers.marathon.developer_instructions
    // and silently drops the persona (§2.4).
    expect(toml.indexOf("developer_instructions")).toBeLessThan(toml.indexOf("["));
  });

  it("writes the TCP transport with host:port + token, plus shim launcher args", () => {
    const toml = codexConfigToml({
      shimCommand: "tsx",
      shimArgs: ["/shim/bin.ts"],
      connect: { tcp: "host.docker.internal:54321" },
      token: "cap-tok",
      instructions: "x",
    });
    expect(toml).toContain('command = "tsx"');
    expect(toml).toContain('args = ["/shim/bin.ts", "--tcp", "host.docker.internal:54321", "--token", "cap-tok"]');
  });

  it("TOML-escapes a persona containing quotes, backslashes, and newlines (§3.1/§2.4)", () => {
    const persona = 'Say "hello"\nUse C:\\path\tand tab';
    const toml = codexConfigToml({
      shimCommand: "s",
      connect: { socket: "/s" },
      instructions: persona,
    });
    // The developer_instructions value must be a valid TOML basic string.
    expect(toml).toContain('developer_instructions = "Say \\"hello\\"\\nUse C:\\\\path\\tand tab"');
    // …and must not contain a raw newline that would break the single-line assignment.
    const line = toml.split("\n").find((l) => l.startsWith("developer_instructions"))!;
    expect(line.endsWith('"')).toBe(true);
  });
});

describe("writeCodexConfigAtomic (§3.1 — config only, never the session state)", () => {
  it("writes config.toml and leaves pre-existing sibling session state untouched", () => {
    const ws = mkdtempSync(join(tmpdir(), "cxws-"));
    const configPath = codexConfigHostPath({ workspaceDir: ws });
    const sessionsPath = codexSessionHostPath({ workspaceDir: ws });
    // Plant a session-state file next to where config.toml will land.
    const { mkdirSync } = require("node:fs");
    mkdirSync(sessionsPath, { recursive: true });
    const rollout = join(sessionsPath, "rollout.jsonl");
    writeFileSync(rollout, "PRECIOUS-RESUME-STATE\n");

    writeCodexConfigAtomic(configPath, codexConfigToml({ shimCommand: "s", connect: { socket: "/s" }, instructions: "i" }));

    // config.toml exists and is correct…
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("[mcp_servers.marathon]");
    // …and the session state beside it is byte-for-byte intact.
    expect(readFileSync(rollout, "utf8")).toBe("PRECIOUS-RESUME-STATE\n");
    // No temp file lingers.
    const { readdirSync } = require("node:fs");
    expect(readdirSync(join(configPath, "..")).filter((f: string) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("resolveCodexModelAccessEnv (§4.1)", () => {
  it("DIRECT mode: injects CODEX_API_KEY + CODEX_HOME + HOME", () => {
    const env = resolveCodexModelAccessEnv({ directKey: "sk-openai-real" });
    expect(env.CODEX_API_KEY).toBe("sk-openai-real");
    expect(env.CODEX_HOME).toBe("/workspace/.marathon-home/.codex");
    expect(env.HOME).toBe("/workspace/.marathon-home");
  });

  it("direct WITHOUT a key throws (fails closed)", () => {
    expect(() => resolveCodexModelAccessEnv({})).toThrow(/needs a model credential/);
  });

  it("locked-down egress THROWS — no OpenAI proxy component exists (§4.1)", () => {
    expect(() => resolveCodexModelAccessEnv({ lockedDownEgress: true, directKey: "sk-openai-real" })).toThrow(
      /locked-down egress .* no route to the OpenAI API/,
    );
  });

  it("SUBSCRIPTION mode: the credential is the auth.json FILE — env carries NO key and NO token", () => {
    const env = resolveCodexModelAccessEnv({ subscription: true, directKey: "sk-should-be-ignored" });
    expect(env.CODEX_API_KEY).toBeUndefined(); // an API key would force per-token billing
    expect(env.CODEX_HOME).toBe("/workspace/.marathon-home/.codex");
    // The login credential moves as a file (stageSubscriptionAuthJson), never env.
    expect(JSON.stringify(env)).not.toContain("sk-should-be-ignored");
    expect(Object.keys(env).sort()).toEqual(["CODEX_HOME", "HOME"]);
  });
});

describe("assertCodexSubscriptionAckIfNeeded (§4.1 — subscription fails closed as dev-only)", () => {
  it("throws when an auth.json path is set without the ack", () => {
    expect(() => assertCodexSubscriptionAckIfNeeded("/home/dev/.codex/auth.json", {})).toThrow(/DEV-ONLY/);
    expect(() => assertCodexSubscriptionAckIfNeeded("/home/dev/.codex/auth.json", {})).toThrow(/MARATHON_CODEX_SUBSCRIPTION_DEV=1/);
  });
  it("passes once the ack is set", () => {
    expect(() =>
      assertCodexSubscriptionAckIfNeeded("/home/dev/.codex/auth.json", { MARATHON_CODEX_SUBSCRIPTION_DEV: "1" }),
    ).not.toThrow();
  });
  it("is a no-op for direct-key mode (no auth.json configured)", () => {
    expect(() => assertCodexSubscriptionAckIfNeeded(undefined, {})).not.toThrow();
  });
});

describe("stageSubscriptionAuthJson (§4.1 — the credential moves as a file)", () => {
  it("copies the host auth.json to $CODEX_HOME/auth.json with mode 0600", () => {
    const ws = mkdtempSync(join(tmpdir(), "cxws-"));
    const src = join(mkdtempSync(join(tmpdir(), "cxauth-")), "auth.json");
    writeFileSync(src, '{"tokens":{"access":"SECRET-LOGIN"}}');
    const dest = stageSubscriptionAuthJson({ workspaceDir: ws, authJsonPath: src });
    expect(dest).toBe(join(ws, ".marathon-home/.codex/auth.json"));
    expect(readFileSync(dest, "utf8")).toBe('{"tokens":{"access":"SECRET-LOGIN"}}');
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  it("fails closed (and names the env var) when the configured file is missing", () => {
    const ws = mkdtempSync(join(tmpdir(), "cxws-"));
    expect(() => stageSubscriptionAuthJson({ workspaceDir: ws, authJsonPath: "/nonexistent/auth.json" })).toThrow(
      /MARATHON_CODEX_AUTH_JSON.*unreadable/s,
    );
  });

  it("lands OUTSIDE the sessions subtree, so per-turn snapshots can never capture it (§5.2)", () => {
    const ws = mkdtempSync(join(tmpdir(), "cxws-"));
    const src = join(mkdtempSync(join(tmpdir(), "cxauth-")), "auth.json");
    writeFileSync(src, "{}");
    const dest = stageSubscriptionAuthJson({ workspaceDir: ws, authJsonPath: src });
    const sessions = codexSessionHostPath({ workspaceDir: ws });
    expect(dest.startsWith(`${sessions}/`)).toBe(false);
  });
});

describe("codex session/config host paths (§5.1/§5.2)", () => {
  it("maps CODEX_HOME under the host workspace mount", () => {
    expect(codexConfigHostPath({ workspaceDir: "/host/ws" })).toBe("/host/ws/.marathon-home/.codex/config.toml");
    expect(codexSessionHostPath({ workspaceDir: "/host/ws" })).toBe("/host/ws/.marathon-home/.codex/sessions");
    // The sessions subdir is configurable (verify-on-pin #7).
    expect(codexSessionHostPath({ workspaceDir: "/host/ws", sessionsSubdir: "rollouts" })).toBe(
      "/host/ws/.marathon-home/.codex/rollouts",
    );
  });
});
