/** The durable resume checkpoint for a task (design.md §11.2). */
export interface Checkpoint {
  completedSteps: string[];
  findings: string[];
}

export const emptyCheckpoint = (): Checkpoint => ({ completedSteps: [], findings: [] });

/** Tolerantly parse a stored checkpoint value, defaulting missing/garbage fields. */
export function parseCheckpoint(value: unknown): Checkpoint {
  if (!value || typeof value !== "object") return emptyCheckpoint();
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
  return {
    completedSteps: strings(v.completedSteps),
    findings: strings(v.findings),
  };
}
