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

**Recorder failure semantics.** Recording is **best-effort and
fail-open**, never fail-closed — a broken or slow DB must not be able to
stop tool execution or corrupt its reported outcome:
- `ToolGateway.run` wraps the `onStart` call in a try/catch (awaiting a
  promise-returning `onStart` inside the same try). If it throws or
  rejects, the error is logged (same logger/channel `ToolGateway` already
  uses for other non-fatal conditions) and `tool.execute()` proceeds
  immediately with `handle = undefined` — a failed `onStart` costs the
  "running" row, nothing else. This is a deliberate change from today's
  implicit behavior where an `onInvocation` failure had no `execute()` to
  gate; it must be made explicit now because `onStart` sits *before*
  `execute()` on the critical path for the first time.
- `ToolGateway.run` likewise wraps each `onComplete(handle, outcome)` call
  in a try/catch. Its result is discarded either way, and a throw/rejection
  is logged and swallowed — it can never replace, mask, or delay the
  `outcome` (`ok` result or thrown error) that `run` returns to its caller.
  This matches today's behavior for `onInvocation`, made explicit for the
  new call site.
- Net effect: a fully-down `dbToolRecorder` degrades `/commands` to "no
  running rows ever appear" (and, for calls whose `onStart` succeeded but
  whose `onComplete` failed, a row stuck at `status = 'running'` — the same
  stale-row class already called out in §33.5), but never degrades tool
  execution itself. This is the same trust boundary the rest of the system
  already assumes (observability is downstream of, not a gate on, agent
  actions) and is not being loosened or tightened here, only stated for the
  first time at this call site.

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

**Schema migration.** `tool_invocation.status` is constrained today to the
values written by `recordToolInvocation` (`"ok" | "error" | "blocked"`);
this change adds a fourth, `"running"`, which is a write path no prior
gateway version ever exercised. Concretely:
- A migration (in `packages/db`'s existing migrations mechanism) adds
  `'running'` to the column's `CHECK`/enum constraint and to any generated
  TypeScript row types alongside it. This is a pure *expand*: no existing
  row or reader is touched, and no existing value is removed or renamed.
- **Deployment ordering:** the migration must be applied and visible to all
  DB connections before any gateway process runs the new
  `onStart`-writes-`'running'` code path. Concretely, roll out as: (1) ship
  and apply the migration; (2) only then deploy the new gateway/recorder
  code. A gateway from *before* this change never attempts to write
  `'running'`, so there is no ordering hazard in the other direction — an
  old gateway running against the migrated schema behaves exactly as it
  does today. If the migration is rolled back, it must first be confirmed
  that no row is left at `status = 'running'` (or those rows must be
  migrated to a terminal status first), since a live constraint rollback
  with existing `'running'` rows would violate the narrowed constraint.
- **Other consumers audited:** `listRecentToolInvocations` and
  `getTaskTimeline` (`packages/observability/src/timeline.ts`) are the only
  two known readers of `tool_invocation.status` outside the write path
  itself; both are addressed directly in this doc (§33.4, §33.5) and pass
  `status` through as an opaque string rather than switching over a closed
  set, so `'running'` requires no additional change in either. Any other
  consumer that assumes the historical three-value closed set (e.g. a
  hand-rolled union type, a generated OpenAPI/GraphQL enum, or a downstream
  analytics job) must be updated to tolerate `'running'` as part of this
  change; none is currently known to exist beyond the two above, but this
  is called out explicitly so a reviewer/implementer can grep for
  `"blocked" | "error" | "ok"`-shaped unions before merging.

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
  misleadingly in-flight. The same stale-row outcome can also result from a
  failed `onComplete` call under the fail-open semantics in §33.4 — both
  are the same accepted gap, not two different ones. A staleness cutoff
  (e.g., treat `running` rows older than N minutes as "stale" in the UI
  rather than "running") is a reasonable follow-up but is not built here —
  flagged, not silently assumed away.

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
  same handle. Add cases for the failure semantics in §33.4: a recorder
  whose `onStart` throws/rejects still lets `tool.execute()` run and
  `run()` return the tool's real outcome; a recorder whose `onComplete`
  throws/rejects still surfaces the real outcome (success or thrown error)
  from `run()` unchanged.
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
  [[32-commands-view-agent-column]] §32.5) — reviewed at the SQL level,
  including manually confirming the migration applies cleanly against the
  existing constraint and that a rollback is blocked while `'running'` rows
  exist.
- `pnpm typecheck`, `pnpm test`.

## 33.8 Open questions

None blocking. The staleness-cutoff follow-up (§33.5) is noted but
deliberately not designed here — no crash-recovery signal exists yet to hang
it off, and it isn't needed to satisfy the request as asked.
