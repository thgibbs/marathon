import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, AgentTurn, AgentTurnContext } from "./types";

/**
 * Chat-task workspace provisioning (§2b #17). The Claude Code harness runs
 * its whole loop inside a container and therefore REQUIRES a workspace
 * binding — which only BUILD tasks used to provide. This decorator closes
 * that provisioning gap for chat/general-agent tasks (Q&A, Slack-initiated
 * doc drafting): when a turn arrives with no workspace, it binds an
 * ephemeral, credential-free scratch directory instead.
 *
 * The scratch dir is STABLE PER TASK (`<root>/<taskId>`), so the harness
 * session under `.marathon-home` survives across turns of the same task —
 * durable-wait resumes re-open the same session (§11.2) without a snapshot
 * restore. It contains no repo checkout and no credentials; grounding comes
 * from the governed tools over the broker (github.read_file, document.*),
 * which flow identically on either harness. A turn that already carries a
 * workspace (the BUILD path) passes through untouched.
 */
export interface ChatWorkspaceOptions {
  /** Host root under which per-task scratch workspaces are created. */
  root: string;
}

export function withChatWorkspace(inner: AgentRuntime, opts: ChatWorkspaceOptions): AgentRuntime {
  return {
    async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
      if (ctx.workspace) return inner.nextTurn(ctx);
      const dir = join(opts.root, ctx.request.taskId);
      // The workspace home is where the harness session/config lives
      // (GUEST_HOME); create it so a fresh container can write immediately.
      mkdirSync(join(dir, ".marathon-home"), { recursive: true });
      // No repo checkout → no pinned commit; the empty baseSha marks that.
      return inner.nextTurn({ ...ctx, workspace: { dir, baseSha: "" } });
    },
  };
}
