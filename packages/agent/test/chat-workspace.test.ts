import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withChatWorkspace } from "../src/chat-workspace";
import type { AgentRuntime, AgentTurnContext, AgentWorkspaceBinding } from "../src/types";
import { emptyCheckpoint } from "@marathon/core";

function recordingRuntime() {
  const seen: Array<AgentWorkspaceBinding | undefined> = [];
  const inner: AgentRuntime = {
    async nextTurn(ctx: AgentTurnContext) {
      seen.push(ctx.workspace);
      return { text: "ok", done: true };
    },
  };
  return { inner, seen };
}

function ctxFor(taskId: string, workspace?: AgentWorkspaceBinding): AgentTurnContext {
  return {
    request: { taskId, instructions: "i", input: "x", modelRef: "anthropic:claude-sonnet-4-6" },
    checkpoint: emptyCheckpoint(),
    workspace,
  };
}

describe("withChatWorkspace (§2b #17)", () => {
  it("binds an ephemeral per-task scratch workspace when none is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-ws-"));
    const { inner, seen } = recordingRuntime();
    const rt = withChatWorkspace(inner, { root });

    await rt.nextTurn(ctxFor("task-1"));
    expect(seen[0]).toEqual({ dir: join(root, "task-1"), baseSha: "" });
    // The workspace home exists so the harness can write its session/config.
    expect(existsSync(join(root, "task-1", ".marathon-home"))).toBe(true);
  });

  it("is stable per task — later turns of the same task get the SAME dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-ws-"));
    const { inner, seen } = recordingRuntime();
    const rt = withChatWorkspace(inner, { root });
    await rt.nextTurn(ctxFor("task-1"));
    await rt.nextTurn(ctxFor("task-1"));
    await rt.nextTurn(ctxFor("task-2"));
    expect(seen[0]!.dir).toBe(seen[1]!.dir);
    expect(seen[2]!.dir).not.toBe(seen[0]!.dir);
  });

  it("passes a BUILD workspace through untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-ws-"));
    const { inner, seen } = recordingRuntime();
    const rt = withChatWorkspace(inner, { root });
    const buildWs = { dir: "/somewhere/materialized", baseSha: "cafe1234" };
    await rt.nextTurn(ctxFor("task-3", buildWs));
    expect(seen[0]).toBe(buildWs);
    expect(existsSync(join(root, "task-3"))).toBe(false);
  });
});
