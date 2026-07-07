import { describe, expect, it } from "vitest";
import {
  claudeArgv,
  claudeSessionHostPath,
  decodeSessionRef,
  disallowedTools,
  encodeSessionRef,
  mcpConfigJson,
} from "../src/claude-code";

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
  maxTurns: 10,
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
    expect(argv.join(" ")).toContain("--max-turns 10");
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
  it("wires the stdio shim to the guest broker socket", () => {
    const cfg = JSON.parse(mcpConfigJson("/run/marathon/broker.sock", { command: "marathon-mcp-shim" }));
    expect(cfg.mcpServers.marathon).toEqual({
      type: "stdio",
      command: "marathon-mcp-shim",
      args: ["--socket", "/run/marathon/broker.sock"],
    });
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
