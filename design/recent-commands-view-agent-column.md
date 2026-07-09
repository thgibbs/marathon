# Recent Commands View: Show Executing Agent

## Overview
Small follow-on to `design/recent-commands-view.md`. The recent-commands
list page (`GET /commands`) currently shows `tool_id`, time, status, error,
input/output summaries, and the owning task — but not *which agent* executed
the command. This adds an **Agent** column so operators can see, at a
glance, which agent ran each command without opening the task detail page.

## Requirements
- List page (`renderCommandsListPage`): add an **Agent** column showing the
  executing agent's `display_name` (falling back to `name`, then to an
  em dash `—` when the task has no `agent_id` — e.g. a `schedule`-triggered
  or system task).
- No change to the task detail page — it already shows the task's agent
  indirectly via existing timeline/report data, and this ask is scoped to
  the list page.

## Data Source
No new tables. `task.agent_id` already references `agent(id)`
(`packages/db/migrations/0001_init.sql`); `agent.name`/`agent.display_name`
already exist. `Database.listRecentToolInvocations` joins `tool_invocation`
to `task` for `task_status` today — it gains a second join to `agent` for
`agent_name`/`agent_display_name`, still scoped by the existing
`t.tenant_id = $1` clause (an agent join can't widen tenant scope: `agent`
is itself tenant-owned, so a left join adds no cross-tenant rows).

`RecentCommand` (`packages/console/src/queries.ts`) gains one field:
`agentLabel: string | null` — `display_name ?? name ?? null`, resolved in
`listRecentCommands` so `render.ts` stays free of fallback logic.

## User Interface Design
- List page table gains one column: `Agent`, rendered via the existing
  `safe()` redaction/escaping helper (same treatment as every other
  free-text cell — an agent's `display_name` is tenant-configurable text,
  not a fixed enum, so it goes through redaction for consistency even
  though it's not expected to carry secrets).
- Null → render `—`.

## Verification
- `pnpm typecheck`
- `pnpm test`
- Extend `packages/console/test` fixtures/tests: a command with an agent
  shows its display name; a command with no agent shows `—`; tenant
  isolation on the join (an agent from another tenant never leaks in,
  covered implicitly by the existing `t.tenant_id` scoping — no new query
  path bypasses it).

## Conclusion
One column, one join, no new storage or scope change — operators can see
which agent ran a command directly from the list page.
