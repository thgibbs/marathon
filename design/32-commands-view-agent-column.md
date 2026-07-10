# 32. Recent Commands View: show the executing agent

> **Status: proposed (2026-07-10).** Requested directly: the commands list
> page (`packages/console`, [[recent-commands-view]]) should also show which
> agent executed each command. Small, additive change to an already-merged,
> already-built view — one new column, sourced from data the `task` table
> already carries. No new tables, no schema change.

## 32.1 Motivation

A **command** ([[recent-commands-view]] §Terminology) is a `tool_invocation`
row, always owned by a `task`, and every `task` optionally carries an
`agent_id` (`packages/db/migrations/0001_init.sql`) identifying which
`Agent` (e.g. Forge, Bruce) ran it. The `/commands` list page
(`packages/console/src/server.ts`) shows `tool_id`, time, status, error,
input/output summaries, and the owning task — but not the agent, even though
it's one join away. Operators scanning recent commands currently have to
open each task's detail page to see which agent ran it.

## 32.2 Current behavior

- `Database.listRecentToolInvocations` (`packages/db/src/index.ts`) joins
  `tool_invocation` to `task` (for tenant scoping and `task_status`) but
  not to `agent`.
- `RecentCommand` (`packages/console/src/queries.ts`) and
  `renderCommandsListPage` (`packages/console/src/render.ts`) have no agent
  field/column.

## 32.3 New behavior

The `/commands` list page gains an **Agent** column: the executing agent's
`display_name`, falling back to `name` when no display name is set, and to
the literal `"no agent"` when `task.agent_id` is null (tasks created without
an agent assignment — this already happens in some test fixtures/edge cases,
so the null case is real, not hypothetical). Plain text, not a link — there
is no agent detail page in v1 ([[recent-commands-view]] Non-Goals already
excludes filtering/sorting controls and unbuilt detail pages; this stays
consistent with that scope line rather than opening a new one).

The task detail page is unchanged: the task's agent is a `next steps` /
follow-up concern there, not part of this change — this is scoped to the
list page only, per the request.

## 32.4 Implementation

- **`packages/db/src/index.ts`** — `listRecentToolInvocations` adds a `left
  join agent on agent.id = t.agent_id` (left, not inner, so tasks with no
  agent still appear) and selects `agent.name as agent_name`,
  `agent.display_name as agent_display_name` alongside the existing columns.
  No new tenant check: an agent is only ever reachable here through a task
  already scoped to `tenant_id = $1`.
- **`packages/console/src/queries.ts`** — `RecentCommand` gains `agentName:
  string | null`, computed in `listRecentCommands` as `r.agent_display_name
  ?? r.agent_name ?? null` (the fallback chain lives here, once, rather than
  in the renderer).
- **`packages/console/src/render.ts`** — `renderCommandsListPage` adds an
  `<th>Agent</th>` column and renders `safe(c.agentName ?? "no agent")` per
  row, same redaction/escaping path (`safe()`) as every other cell — agent
  name/display name are operator-configured labels, not user- or
  model-generated free text, so `redactSecrets` is a no-op on them in
  practice, but running it costs nothing and keeps the "every rendered field
  goes through `safe()`" invariant simple to audit.

## 32.5 Testing

- `packages/console/test/queries.test.ts` — `listRecentCommands` maps
  `agent_name`/`agent_display_name` onto `agentName`, preferring display
  name over name, and produces `agentName: null` when both are absent.
- `packages/console/test/server.test.ts` — `handleConsoleRequest` on
  `/commands` renders the display name when present, falls back to name when
  display name is null, and renders "no agent" when the row carries no
  agent at all.

## 32.6 Scope boundary

List page only. No change to the task detail page, no agent detail/profile
page, no filtering by agent — all already out of scope per
[[recent-commands-view]] Non-Goals, and this doesn't reopen any of them.

## 32.7 Open questions

None blocking — additive column on an existing read-only view, no data model
or policy impact.
