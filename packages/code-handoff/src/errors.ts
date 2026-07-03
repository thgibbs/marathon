/**
 * Typed, agent-visible errors for the BUILD → DELIVER handoff (design §29.4, §29.7).
 * Every gateway-check failure carries a code so the agent can correct course
 * in-session (narrow the diff, remove a secret, fix the plan ref, …).
 */
export type CodeHandoffErrorCode =
  | "NO_WORKSPACE"        // no code workspace bound to this task (not in BUILD stage)
  | "PLAN_REF_MISMATCH"   // echoed plan_ref does not match the task's plan_ref
  | "EMPTY_DIFF"          // nothing changed in the workspace
  | "DIFF_TOO_LARGE"      // over the files/lines/bytes caps
  | "PROTECTED_PATH"      // touches a refused path (e.g. .github/workflows/**)
  | "SECRET_IN_DIFF";     // a known secret pattern in the added lines

export class CodeHandoffError extends Error {
  constructor(
    public readonly code: CodeHandoffErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CodeHandoffError";
  }
}
