# 30. Task failure reporting (budget-exhausted reply)

## 30.1 Problem

Slack ask: "if the agent budget is out, it should reply 'budget exhausted' instead of (no response)."

Root cause, traced through the current code:

* A turn's spend is checked before it runs: `assertWithinBudget` / `assertWithinTaskBudget`
  (`packages/observability/src/budget.ts`) throw `BudgetExceededError` when the
  agent or task budget is already spent. This happens inside
  `makeAgentTaskStepRunner` (`packages/worker/src/agent-step.ts`), before the
  step appends anything to `checkpoint.findings`.
* `Worker.runOnce` (`packages/worker/src/worker.ts`) catches the throw.
  `classifyError` (`packages/queue/src/backoff.ts`) matches only network/rate-limit
  patterns as `"transient"`; `BudgetExceededError`'s message ("budget exceeded:
  spent $X of $Y") doesn't match, so it is classified `"permanent"`. The worker
  calls `safeFailTask`, which transitions the task to `failed` and **discards
  the error string** (`safeFailTask(taskId, _error)` — the parameter is unused),
  then dead-letters the job.
* Back in `runAndReport` (`packages/slack-app/src/handlers.ts`), after
  `worker.drain()` the task is `failed` (not `waiting_for_input`, the only
  status that short-circuits reporting), so it builds a `StructuredResult` from
  the checkpoint:

  ```ts
  const result: StructuredResult = {
    summary: cp.findings.at(-1) ?? "(no response)",
    ...
  };
  ```

  Since the failed turn never appended a finding, `cp.findings.at(-1)` is
  `undefined` on a task's first turn, and the literal string `"(no response)"`
  is posted to the Slack thread — the exact bug reported.

This is a general gap, not budget-specific: **any** permanent step failure
(budget exceeded, an unexpected exception, etc.) that occurs before a turn
produces text results in `"(no response)"`, because the failure reason is
never persisted anywhere `runAndReport` can read it. The fix generalizes to
"report *why* a task failed" and special-cases budget exhaustion with the
exact wording asked for.

## 30.2 Fix

**Persist the failure reason on the task**, then have `runAndReport` render it
instead of falling back to the checkpoint when the task ended in `failed`.

1. **`packages/core/src/entities.ts`**: add `lastError: string | null` to `Task`.
2. **`packages/db/migrations/0012_task_last_error.sql`**: `alter table task add
   column last_error text;`
3. **`packages/db/src/index.ts`**:
   * `rowToTask` maps `last_error` → `lastError`.
   * `transitionTask(id, to, opts?: { error?: string })` stamps `last_error =
     $error` alongside the existing timestamp column when `opts.error` is
     given (only ever passed when `to === "failed"`). Existing callers are
     unaffected (the param is optional).
4. **`packages/worker/src/worker.ts`**: `safeFailTask` currently discards its
   `error` argument — pass it through to `transitionTask(taskId, "failed", {
   error })` instead of dropping it.
5. **`packages/slack-app/src/handlers.ts`** (`runAndReport`): when
   `finalTask?.status === "failed"`, build the summary from `finalTask.lastError`
   instead of the checkpoint fallback:
   * If the stored error is a budget failure (name/message produced by
     `BudgetExceededError` — matched the same way `classifyError` matches
     patterns, e.g. `/^budget exceeded/i`), reply with a fixed, friendly
     string: **`"Budget exhausted — this task's spending cap was reached
     before it could finish."`** (contains "budget exhausted" per the ask).
   * Otherwise, reply with a generic but still non-empty failure message,
     e.g. `` `This task failed: ${finalTask.lastError}` ``, still better than
     a silent "(no response)".
   * When the task did *not* fail, behavior is unchanged (existing
     `cp.findings.at(-1) ?? "(no response)"` fallback stays as the belt-and-
     suspenders case for a completed task with no findings, which should not
     happen in practice but is not this bug).

No change to retry/dead-letter behavior, budget policy, or the state machine —
this only makes the existing terminal `failed` state observable to the user
that's waiting on a reply.

## 30.3 Out of scope

* Distinguishing per-turn budget vs. per-task budget in the message (both map
  to `BudgetExceededError`; the reply doesn't need to say which cap).
* Admin/dashboard surfacing of `lastError` (§11.5 dead-letter queue UI) — this
  doc only wires the column and the Slack reply; a fuller admin view can read
  the same column later.
* Retrying automatically when budget frees up — out of scope; the user must
  re-mention the agent.

## 30.4 Testing

* Unit test for `runAndReport` (or the pure function it's refactored to
  extract, if needed for testability): given a `failed` task with
  `lastError` set to a `BudgetExceededError`-style message, the delivered
  result's `summary` contains "budget exhausted".
* Unit test for a `failed` task with a non-budget `lastError`: summary is the
  generic failure message, not `"(no response)"`.
* Existing worker/db tests continue to pass; add a test that
  `safeFailTask`/`transitionTask` persists `lastError`.
