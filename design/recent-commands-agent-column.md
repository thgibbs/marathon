# Recent Commands: Show the Executing Agent

## Overview
Small amendment to [`recent-commands-view.md`](../recent-commands-view.md): the
`/commands` list page (`packages/console`) currently shows each command
(`tool_invocation` row) with its tool id, time, status, error, input/output
summary, and owning task — but not which **agent** executed it. Since each
task carries an `agent_id` (nullable — `task.agentId`, `Agent.name` /
`displayName` in `packages/core/src/entities.ts`), this is one more column
sourced from data Marathon already records. No new storage.

## Requirement
Add an **Agent** column to the `/commands` list page: the owning task's
agent, rendered as `displayName ?? name`, or an explicit placeholder (e.g.
`—`) when `task.agentId` is `null` (agent-less tasks are valid — e.g. manual
runs — so this is expected, not an error state).

## Data Source
`Database.listRecentToolInvocations` (`packages/db/src/index.ts`) already
joins `tool_invocation` to its owning `task` for `task_status`. Extend that
same query with a `left join agent a on a.id = t.agent_id`, selecting
`coalesce(a.display_name, a.name) as agent_name`. One query, no N+1 lookups,
consistent with how `task_status` is already resolved.

`packages/console/src/queries.ts`'s `RecentCommand` gets one new field,
`agentName: string | null`, populated from that column.

## UI Change
`packages/console/src/render.ts`: `renderCommandsListPage` adds an `Agent`
header/cell to the existing table, rendered through the same `safe()`
(redact-then-escape) helper as the other free-text cells for consistency,
even though agent names aren't expected to carry secrets.

## Scope
This targets the **list page** only, matching the request ("commands...show
the agent that executes the command") — each row there can belong to a
different agent, which is exactly the ambiguity worth resolving. The task
**detail page** (`/tasks/:id`) is already scoped to one task and therefore
one agent throughout; adding a redundant per-task "Agent" line there is a
plausible small follow-up but is left out here to keep this change small and
focused on what was asked.

## Non-Goals
- No filtering/sorting by agent (matches the list page's existing v1
  no-filtering stance).
- No change to the task detail page (see Scope).
- No new `Database` read method beyond extending the existing joined query.

## Verification
- `pnpm typecheck`
- `pnpm test`
- New unit test: a command whose task has an agent renders that agent's
  `displayName` (falling back to `name`) in the Agent column.
- New unit test: a command whose task has no agent (`agentId` null) renders
  the placeholder, not a blank/undefined cell.

## Conclusion
One additional left join and one additional table column surface an agent
identity that Marathon already records per task, with no new storage and no
scope beyond the existing list page.
