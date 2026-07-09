# Recent Commands: Show the Executing Agent

## Overview
Small amendment to [`recent-commands-view.md`](recent-commands-view.md). The
recent-commands list page (`/commands`) mixes `tool_invocation` rows from
many tasks, each potentially run by a different agent. Today the row shows
only the tool id, task id, and status — the operator has to open the task
detail page to see which agent ran it. This adds an **Agent** column to the
list page so that's visible at a glance.

## Change
`Database.listRecentToolInvocations` joins `tool_invocation` → `task`
already (for `task_status`); extend that join to `task.agent_id` → `agent`
and select `agent.name`/`agent.display_name`. `task.agent_id` is nullable
(tasks aren't required to have an agent), so the column reads `—` when
there's no agent.

- `packages/db/src/index.ts`: `listRecentToolInvocations` — left join
  `agent` on `agent.id = t.agent_id`, select `a.name as agent_name`,
  `a.display_name as agent_display_name`.
- `packages/console/src/queries.ts`: `RecentCommand` gains
  `agentName: string | null` (`display_name ?? name ?? null`, computed once
  here so `render.ts` doesn't repeat the fallback logic).
- `packages/console/src/render.ts`: `renderCommandsListPage` adds an
  **Agent** column (rendered through `safe()` like every other free-text
  field, though agent names aren't expected to carry secrets — consistency
  with the rest of the row, not a redaction concern here).

No schema change (`agent_id` already exists on `task`), no change to the
task detail page (a task detail page is already scoped to one task = one
agent, so there's nothing ambiguous to add there).

## Verification
- `pnpm typecheck`
- `pnpm test`
- Extend `packages/console/test/queries.test.ts` /
  `packages/db` tests: a tool invocation whose task has an agent shows that
  agent's display name (falling back to `name`); a tool invocation whose
  task has no agent (`agent_id is null`) shows `—`, not a crash.
- Extend `packages/console/test/render.test.ts` to assert the Agent column
  renders for both cases above.

## Non-Goals
- No filtering/grouping by agent (consistent with the parent doc's v1
  no-filtering-controls stance).
- No agent column on the task detail page (redundant with the page's
  existing Trigger/task-level context).
