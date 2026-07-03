import type { PlanRef } from "@marathon/core";
import type { CodeWorkspace } from "./workspace";

/**
 * What the handoff tool needs to know about a task in its BUILD stage: the
 * host-side workspace the gateway reads the diff from, and the plan binding it
 * validates against (§29.4 step 1-2). The worker registers this when it
 * provisions the workspace and removes it on teardown.
 */
export interface CodeTaskContext {
  workspace: CodeWorkspace;
  planRef: PlanRef;
  repo: string;
  baseSha: string;
  /** PR base; defaults to "main". */
  defaultBranch?: string;
}

export class CodeTaskRegistry {
  private readonly tasks = new Map<string, CodeTaskContext>();

  set(taskId: string, ctx: CodeTaskContext): void {
    this.tasks.set(taskId, ctx);
  }

  get(taskId: string): CodeTaskContext | undefined {
    return this.tasks.get(taskId);
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
  }
}
