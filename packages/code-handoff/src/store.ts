import type { CodeChange, CodeChangeState, NewCodeChange, VerificationResult } from "@marathon/core";

export interface CodeChangeSubmission {
  treeHash: string;
  prNumber: number;
  prUrl: string;
  state: CodeChangeState;
  verification: VerificationResult[];
}

/**
 * A PR reported by the agent-driven delivery path (`delivery.report_pr`,
 * Track 7): the agent committed/pushed/opened the PR itself through the
 * brokered `git`/`gh` commands, so there is no gateway-captured tree hash —
 * the record binds the task to the PR it delivered.
 */
export interface CodeChangeReport {
  prNumber: number;
  prUrl: string;
  /** The PR's head branch (from GitHub, not from the model). */
  branch: string;
  state: CodeChangeState;
  verification: VerificationResult[];
}

/**
 * Persistence for the CodeChange record (§10.19, §29.8). `Database` in
 * `@marathon/db` implements this structurally; the in-memory store below backs
 * tests and demos.
 */
export interface CodeChangeStore {
  createCodeChange(input: NewCodeChange): Promise<CodeChange>;
  getCodeChangeByTask(taskId: string): Promise<CodeChange | null>;
  updateCodeChangeSubmission(taskId: string, patch: CodeChangeSubmission): Promise<CodeChange>;
  recordCodeChangeReport(taskId: string, patch: CodeChangeReport): Promise<CodeChange>;
}

export class InMemoryCodeChangeStore implements CodeChangeStore {
  private readonly byTask = new Map<string, CodeChange>();
  private seq = 1;

  async createCodeChange(input: NewCodeChange): Promise<CodeChange> {
    const existing = this.byTask.get(input.taskId);
    if (existing) return existing;
    const now = new Date();
    const change: CodeChange = {
      id: `cc-${this.seq++}`,
      tenantId: input.tenantId,
      taskId: input.taskId,
      repo: input.repo,
      planRef: input.planRef,
      baseSha: input.baseSha,
      branch: input.branch,
      treeHash: null,
      prNumber: null,
      prUrl: null,
      state: "building",
      verification: [],
      createdAt: now,
      updatedAt: now,
    };
    this.byTask.set(input.taskId, change);
    return change;
  }

  async getCodeChangeByTask(taskId: string): Promise<CodeChange | null> {
    return this.byTask.get(taskId) ?? null;
  }

  async updateCodeChangeSubmission(taskId: string, patch: CodeChangeSubmission): Promise<CodeChange> {
    const existing = this.byTask.get(taskId);
    if (!existing) throw new Error(`code_change not found for task: ${taskId}`);
    const updated: CodeChange = { ...existing, ...patch, updatedAt: new Date() };
    this.byTask.set(taskId, updated);
    return updated;
  }

  async recordCodeChangeReport(taskId: string, patch: CodeChangeReport): Promise<CodeChange> {
    const existing = this.byTask.get(taskId);
    if (!existing) throw new Error(`code_change not found for task: ${taskId}`);
    const updated: CodeChange = { ...existing, ...patch, updatedAt: new Date() };
    this.byTask.set(taskId, updated);
    return updated;
  }
}
