# 33. Commands View: show currently-running commands

> **Status: proposed (2026-07-10).** Requested directly: the commands list
> page (`packages/console`, [[recent-commands-view]]) should show which
> commands are currently running, pinned to the top and visually denoted.
> Unlike [[32-commands-view-agent-column]], this is not a pure read-side
> addition — the underlying data has no "running" state to read today, so
> this doc covers a small recording-side change too.

## 33.1 Motivation

A **command** ([[recent-commands-view]] §Terminology) is a `tool_invocation`
row. Operators watching `/commands` currently have no way to tell which
commands are in flight right now vs. already finished — everything in the
list is a completed outcome (`ok`/`error`/`blocked`).

## 33.2 Current behavior (why "running" doesn't exist yet)

`tool_invocation` rows are written **once, after the fact**:

- `ToolGateway.run` (`packages/tools/src/gateway.ts`) calls
  `tool.execute(...)`, waits for it to settle, and only then calls
  `recorder.onInvocation(...)` with the final `status` (`"ok"` on success,
  `"error"` on a thrown error; pre-execution rejections — unknown tool,
  failed validation, policy-denied, egress-denied — also record a single
  terminal row, `"blocked"`/`"error"`, before `execute` is ever called).
- `dbToolRecorder` (`packages/db/src/index.ts`) persists that one row via
  `Database.recordToolInvocation`, a single `insert`.
- `Database.listRecentToolInvocations` orders by `created_at desc` — since
  every row is written post-hoc, `created_at` is effectively "when this
  finished," and there is no row that ever represents "still running."

So "show what's currently running" cannot be built as a read-only view over
existing data (unlike [[32-commands-view-agent-column]]); it requires writing
a row *before* execution and updating it in place when the call settles.

## 33.3 New behavior

On `/commands`:
- Commands whose underlying tool call is still executing are **sorted to the
  top** of the list, most-recently-started first, ahead of all completed
  commands (which keep today's newest-first order beneath them).
- Their **Status** cell is visually denoted — rendered as `● RUNNING`
  (bold), instead of the raw status string.

No new columns, no new page, no polling/live-refresh: a page reload is
sufficient (consistent with [[recent-commands-view]] Non-Goals — no
WebSocket/SSE in v1).

Only calls that reach `tool.execute()` ever have a "running" phase —
pre-execution rejections (unknown tool, validation, policy, egress) fail
synchronously and are unaffected by this change; they still record a single
terminal row exactly as today.

## 33.4 Design: two-phase recording around `tool.execute()`

**`packages/tools/src/gateway.ts`**
- `ToolRecorder` gains two methods used only around the `tool.execute()`
  call (the pre-execution rejection paths keep using `onInvocation`
  unchanged):
  ```ts
  onStart(rec: ToolInvocationStart): unknown | Promise<unknown>; // may return an opaque handle
  onComplete(handle: unknown, outcome: ToolInvocationOutcome): unknown | Promise<unknown>;
  ```
  `ToolInvocationStart` carries `taskId`, `toolName`, `riskAxes`,
  `inputSummary` (the same fields `onInvocation` gets today, minus the
  outcome fields). `ToolInvocationOutcome` carries `status: "ok" | "error"`,
  `outputSummary?`, `error?`. (`ToolInvocationRecord.status` narrows to
  `"blocked" | "error"` and drops the now-unused `outputSummary` field, since
  the only remaining `onInvocation` callers are the pre-execution paths,
  which never produce `"ok"` or an output summary.)
- `ToolGateway.run` calls `onStart` immediately before `tool.execute()`,
  keeps the returned handle, and calls `onComplete(handle, outcome)` in both
  the success and catch branches (in place of today's single
  `onInvocation` call there). `recorder` stays optional throughout — a
  gateway with no recorder configured just skips all of this, as today.

**`packages/db/src/index.ts`**
- `Database.startToolInvocation(rec)` — `insert into tool_invocation(task_id,
  tool_id, status, risk_axes, input_summary) values (..., 'running', ...)
  returning id`.
- `Database.completeToolInvocation(id, rec)` — `update tool_invocation set
  status = $2, output_summary = $3, error = $4 where id = $1`.
- `dbToolRecorder` implements `onStart`/`onComplete` on top of these two
  methods, passing the returned id through as the handle.
- `listRecentToolInvocations`'s `order by` becomes
  `order by (ti.status = 'running') desc, ti.created_at desc` — running rows
  first (newest-started first among themselves), then everything else by
  recency, same `limit`. This is the entire "pin to top" mechanism; no
  second query, no separate section.

**`packages/console/src/render.ts`**
- `renderCommandsListPage` renders the Status cell as `<strong>&#9679;
  RUNNING</strong>` when `c.status === "running"`, else the existing
  `safe(c.status)`. No changes to `queries.ts` or `server.ts` — `status` was
  already plumbed through as a plain string.

## 33.5 Side effects, called out rather than glossed over

- **Timeline timestamps shift for tool calls.** `getTaskTimeline`
  (`packages/observability/src/timeline.ts`) sorts tool-call events by
  `tool_invocation.created_at`. Today that's "when the call finished"; after
  this change it's "when the call started" (the row is inserted at start and
  updated in place, not re-inserted at completion). This is a more accurate
  timestamp for a timeline, not a regression, but is a real behavior change
  worth naming. A still-running call now also shows up on the task detail
  page's timeline with `status: running` — for free, since it reads the same
  rows — but building that view is not part of this change's scope.
- **Bounded-window interaction.** The list stays capped at the existing
  `limit` (default 100, [[recent-commands-view]] §List page). Running rows
  are prioritized *within* that window; if a tenant somehow has more
  concurrently-running commands than the window size, the oldest-started
  excess would still be excluded. Same v1 pragmatism as the existing
  "no pagination" cut — not solved here.
- **No heartbeat/timeout.** If the process crashes mid-`tool.execute()`, the
  row is left at `status = 'running'` forever — nothing ever calls
  `onComplete` for it. Stated explicitly as an accepted v1 gap: a stale
  "running" row will sit at the top of `/commands` indefinitely and read as
  misleadingly in-flight. A staleness cutoff (e.g., treat `running` rows
  older than N minutes as "stale" in the UI rather than "running") is a
  reasonable follow-up but is not built here — flagged, not silently
  assumed away.

## 33.6 Scope boundary

`/commands` list page and the recording path it depends on. No new page, no
polling, no change to the task detail page's *rendering* (it inherits the
new `running` status/timestamp for free, per §33.5, but nothing there is
purpose-built for this). No agent-facing behavior change — `tool.execute()`
itself, its inputs/outputs, and policy enforcement are untouched; this only
changes when/how the outcome is persisted.

## 33.7 Testing

- `packages/tools/test/gateway.test.ts` — update the recorder fake to
  implement `onStart`/`onComplete` (merging start input + outcome into the
  existing `invocations` array keeps current assertions like
  `invocations[0]?.status === "ok"` valid); add a case asserting `onStart`
  fires before `tool.execute()` resolves (e.g. a tool whose `execute` blocks
  on a manually-resolved promise) and `onComplete` fires after, with the
  same handle.
- `packages/agent/test/codex.test.ts`, `packages/agent/test/claude-code.test.ts`
  — update the local recorder fakes the same way (both already assert on a
  final merged record shape; behavior unaffected, just re-plumbed).
- `packages/console/test/render.test.ts` — `renderCommandsListPage` renders
  `● RUNNING` (bold) for a command with `status: "running"`, and renders the
  plain status text otherwise; a `running` command sorts first in a mixed
  fixture list *as passed in* (render trusts input order — the sort itself
  is a DB-level concern, see below).
- The `order by (status = 'running') desc, created_at desc` change is not
  covered by an automated regression test: `packages/db` has no unit/
  integration test harness in this repo (same gap noted in
  [[32-commands-view-agent-column]] §32.5) — reviewed at the SQL level.
- `pnpm typecheck`, `pnpm test`.

## 33.8 Open questions

None blocking. The staleness-cutoff follow-up (§33.5) is noted but
deliberately not designed here — no crash-recovery signal exists yet to hang
it off, and it isn't needed to satisfy the request as asked.
