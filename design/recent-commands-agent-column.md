# Recent Commands: Show the Executing Agent

## Overview
Small addendum to [`recent-commands-view.md`](./recent-commands-view.md). The
recent-commands list page (`GET /commands`) currently shows, per
`tool_invocation` row: tool id, time, status, error, input/output summary, and
the owning task (id + status). It does not show *which agent* ran the
command. This adds one column: the agent that executed the command, i.e. the
agent bound to the owning task (`task.agent_id`).

## Requirement
- Add an **Agent** column to the `/commands` list page, between "Tool" and
  "Time".
- Value shown: the owning task's agent `display_name` (falling back to
  `name` if no display name is set), resolved via `task.agent_id →
  agent.id`.
- Tasks with no bound agent (`task.agent_id is null` — e.g. ad hoc/manual
  tasks) render as `—`, not blank or an error.
- No change to the task detail page — the Trigger/Timeline sections there
  already show the task, and a task has exactly one agent for its whole
  lifetime, so there's no per-command ambiguity to resolve there.

## Data Source
Extend `Database.listRecentToolInvocations` (`packages/db/src/index.ts`) to
join `agent` on `task.agent_id = agent.id` (left join, since `agent_id` is
nullable) and select `agent.name`, `agent.display_name`. No new tables, no
new tenant-scoping concerns: the existing join is already scoped through
`task.tenant_id = $1`, and `agent.tenant_id` matches `task.tenant_id` by
construction (agents are created per-tenant and tasks reference their own
tenant's agents).

`listRecentCommands` (`packages/console/src/queries.ts`) adds an `agentLabel:
string | null` field to `RecentCommand`, computed as `display_name ?? name ??
null`.

## UI Change
`renderCommandsListPage` (`packages/console/src/render.ts`) adds an `<th>Agent</th>`
header and a `<td>${safe(c.agentLabel ?? "—")}</td>` cell per row, redacted
through the existing `safe()` helper like every other free-text field on this
page.

## Verification
- `pnpm typecheck`
- `pnpm test`
- Extend `packages/console/test/queries.test.ts`: `listRecentCommands` maps a
  row with an agent name through to `agentLabel`, and a row with
  `agent_id: null` maps to `agentLabel: null`.
- Extend `packages/console/test/server.test.ts`: `/commands` response
  contains the agent's display name for a fixture row, and renders `—` when
  the owning task has no bound agent.

## Non-Goals
- No agent column on the task detail page (see Requirement).
- No filtering/grouping by agent on the list page — out of scope, matches the
  parent doc's no-filtering non-goal.
