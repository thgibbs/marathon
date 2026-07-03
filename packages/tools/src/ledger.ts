import type { SourceRead } from "./types";

/**
 * The per-task source-sensitivity ledger (design §7.8, §12.2): every governed
 * read records what it read and how sensitive it is, so egress can be routed
 * deterministically against what the task has seen. This is access metadata,
 * not content — the exfil axis is evaluated from it, never from a classifier.
 */
export interface SourceLedger {
  record(taskId: string, sources: SourceRead[]): unknown | Promise<unknown>;
  list(taskId: string): SourceRead[] | Promise<SourceRead[]>;
}

/** In-process ledger, deduplicated by source id (highest sensitivity wins). */
export class InMemorySourceLedger implements SourceLedger {
  private readonly byTask = new Map<string, Map<string, SourceRead>>();

  record(taskId: string, sources: SourceRead[]): void {
    let task = this.byTask.get(taskId);
    if (!task) {
      task = new Map();
      this.byTask.set(taskId, task);
    }
    for (const s of sources) {
      const existing = task.get(s.source);
      if (!existing || rank(s.sensitivity) > rank(existing.sensitivity)) task.set(s.source, s);
    }
  }

  list(taskId: string): SourceRead[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }
}

function rank(s: SourceRead["sensitivity"]): number {
  return s === "restricted" ? 2 : s === "company_viewable" ? 1 : 0;
}
