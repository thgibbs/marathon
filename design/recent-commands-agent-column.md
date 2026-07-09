# Recent Commands: Show the Executing Agent

## Overview
Follow-on to [`recent-commands-view.md`](recent-commands-view.md) (the read-only
`@marathon/console` HTTP server: a recent-commands list page and a per-task detail
page). Today neither page shows *which configured agent* (`agent.name` /
`agent.display_name`, `task.agent_id`) ran a given command. This adds that field to
both pages so an operator scanning recent commands doesn't have to open each task to
find out which agent executed it.

## Requirements

### List page (`/commands`)
- Add an **Agent** column to the commands table, alongside the existing Tool, Time,
  Status, Error, Input, Output, Task columns.
- Value: the owning task's agent — `agent.display_name` if set, else `agent.name`.
  A task with `agent_id is null` (no configured agent, e.g. an ad hoc/system task)
  renders as `—`.

### Detail page (`/tasks/:id`)
- Add the same agent name (or `—`) as one field in the existing status line at the
  top of the page (next to status/cost/call-counts), not a per-row addition — every
  command on this page already belongs to the one task shown, so it only needs to
  appear once.

## Data Source
No new tables. `agent.name`/`agent.display_name` joined via `task.agent_id`
(`packages/db/migrations/0001_init.sql`):
- **List page**: extend `Database.listRecentToolInvocations`'s existing
  `tool_invocation join task` query with a `left join agent` (left, since
  `task.agent_id` is nullable) and select `agent.name`/`agent.display_name`.
- **Detail page**: `handleConsoleRequest` already loads `task` (which carries
  `agentId`); add one new small read, `Database.getAgent(agentId)` (mirrors the
  existing `getTask`/`getLatestAgentVersion` shape — no method to fetch a single
  agent by id exists today), to resolve the name for the status line.

Both reads stay inside the existing tenant scoping: the list query's join is scoped
by the same `t.tenant_id = $1` clause it already has, and the detail page's task is
already tenant-checked before any agent lookup happens.

## Redaction
Agent `name`/`display_name` are tenant-admin-configured labels, not free text from
an external surface — but for consistency every rendered field on these pages goes
through the same `safe()` (redact + escape) helper already used for the other
columns, and this is no exception.

## Non-Goals
- Filtering/grouping the list by agent (the existing design's "no filtering
  controls in v1" non-goal still applies).
- Any change to `tool_invocation` itself — it doesn't carry an agent reference and
  doesn't need one; the join is via its owning task.
- Showing agent version, policy, or other `agent`/`agent_version` fields — name only.

## Verification
- `pnpm typecheck`
- `pnpm test`
- New/updated unit tests:
  - List-page rendering includes the agent's display name for a fixture command,
    and renders `—` for a command whose task has `agent_id = null`.
  - Detail-page status line shows the task's agent name (or `—`).

## Conclusion
A small, additive change: one join for the list query, one new single-agent lookup
for the detail page, and one rendered field on each — no new storage, no
change to tenant scoping or redaction posture.
