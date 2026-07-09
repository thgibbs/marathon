# 32. Recent commands: show the executing agent

> **Status: proposed (2026-07-09).** Requested directly in Slack: the recent-commands list
> page (`design/recent-commands-view.md`) should also show which agent executed each command.
> Small, scoped addition to that existing view — no new tables, no change to the detail page.

## 32.1 Motivation

The list page at `GET /commands` (`packages/console/src/server.ts`) shows one row per
`tool_invocation`: tool id, time, status, error, input/output summary, and the owning task
(id + status). A tenant can run more than one agent, and the row currently has no way to tell
*which* agent issued a given command without opening the task detail page. Surfacing the agent
directly on the list row makes it scannable at a glance, which is the whole point of a recent-
commands list.

## 32.2 Current behavior

* `Database.listRecentToolInvocations(tenantId, limit)` (`packages/db/src/index.ts`) joins
  `tool_invocation` to its owning `task` (for `task_status`) but not to `agent`.
* `task.agent_id` (nullable — `on delete set null`) references `agent.id`; `agent.name` is the
  internal slug, `agent.display_name` the human-facing name (`design/10-data-model.md`,
  `packages/db/migrations/0001_init.sql`).
* `queries.listRecentCommands` maps the raw rows to `RecentCommand`; `render.renderCommandsListPage`
  renders that into an HTML table. Neither carries agent info today.

## 32.3 New behavior

* `listRecentToolInvocations` left-joins `agent` on `agent.id = task.agent_id` and additionally
  selects `agent.name`, `agent.display_name`. Left join, not inner — `task.agent_id` can be
  null, and an unrelated join failure must not drop a command row from the list.
* `RecentCommand` gains one field: `agentLabel: string | null` — `display_name ?? name ?? null`,
  computed once in `listRecentCommands` so `render.ts` stays a straight mapper.
* `renderCommandsListPage` adds an **Agent** column between Tool and Time, rendering
  `agentLabel` through the existing `safe()` redaction/escaping helper (display names are
  operator-authored text, not guaranteed secret-free) and falling back to an em dash (`—`) when
  `agentLabel` is null (task predates agent assignment, or its agent was deleted).
* No change to the detail page (`renderTaskDetailPage`) — it already shows the task's agent
  implicitly via the task itself; out of scope here since the ask was specifically about the
  commands list.

## 32.4 Data source

No new tables. Adds one `left join agent` to the existing `listRecentToolInvocations` query in
`packages/db/src/index.ts`, and one derived field (`agentLabel`) in `packages/console/src/queries.ts`.

## 32.5 Verification

* `pnpm typecheck`
* `pnpm test`
* New/updated unit tests:
  * `queries.test.ts`: `listRecentCommands` maps `agent_name`/`agent_display_name` into
    `agentLabel`, preferring `display_name` over `name`.
  * `queries.test.ts`: a row with no agent (`agent_id` null) maps to `agentLabel: null`.
  * `render.test.ts` (or wherever list-page rendering is covered): the Agent column shows the
    label, and shows `—` when `agentLabel` is null.

## 32.6 Conclusion

One left join, one derived field, one table column — the agent that ran each command is now
visible on the recent-commands list without touching storage or the detail page.
