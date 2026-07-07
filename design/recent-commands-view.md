# Recent Commands View

## Overview
This document proposes a small, read-only web view over data Marathon already
records: a **list page** of recent commands (tool invocations) across tasks,
and a **task detail page** that shows the full chain for one task — its
trigger (GitHub/Slack), the ask that started it, its execution timeline
(steps, model calls, tool calls, approvals, delivery outcome), and the other
tasks in the same conversation/chain ("previous threads"). Nothing here adds
new storage; it reads and composes existing tables and `@marathon/observability`
APIs.

## Terminology
A **command** is a `tool_invocation` row: one governed tool call (including
brokered `github.exec`/`git.exec`), with its `tool_id`, `status`, `error`,
`input_summary`/`output_summary`, and `risk_level`. "Recent commands" is the
most recent `tool_invocation` rows across a tenant's tasks, newest first.

## Requirements

### List page — recent commands
- Show the most recent `tool_invocation` rows for the tenant: `tool_id`,
  `created_at`, `status`, `error` (if any), and the owning task (id + status),
  linked to that task's detail page.
- A simple bounded window (e.g. most recent 100) is sufficient; no pagination
  controls in v1 (see Non-Goals).

### Detail page — one task's full chain
For a single task, show:
1. **Trigger** — `task.source_type` (`slack` | `github` | `web` | `api` |
   `email` | `schedule`) and `task.source_ref` (e.g. `{repo, number,
   comment_id}` for GitHub, `{channel, thread_ts}` for Slack), rendered as a
   link back to the originating PR/issue comment or Slack thread where the
   `source_ref` gives enough to build one.
2. **Prompt** — `task.input_text`, the ask text Marathon parsed from that
   GitHub comment or Slack mention (see `@marathon/surface-github`'s
   `classifyGithubEvent` / `@marathon/surface-slack`'s `parseAppMention`,
   `parseThreadReply`). Rendered through redaction (see below).
3. **Context / result** — the task's full timeline via
   `getTaskTimeline(db, tenantId, taskId)`: steps, model calls (provider,
   model, tokens, cost, `prompt_version` — see the explicit limitation
   below), tool calls, approvals, audit events, and the delivery outcome
   (verification results + PR URL, when present). `getTaskReport` supplies
   the summary rollup (cost, call counts, failures) shown at the top of the
   page.
4. **Related tasks ("previous threads")** — other tasks in the same chain or
   conversation:
   - **Chain ancestry**: walk `task.source_task_id` up (the task this one was
     spawned from — e.g. a Slack ask → its design-doc task → its
     implementation task, design §29.1) and list descendants via
     `Database.findTaskBySourceTask`/`countTasksBySourceTask`.
   - **Thread/PR siblings**: other tasks anchored to the same external
     conversation. `Database` already has the lookups for the *latest* one
     (`findLatestTaskByThread` for Slack, `findActiveRevisionTask` for
     GitHub); this view needs the small addition of a **list** version of
     each (same `source_ref` match, ordered by `created_at`, no new columns)
     to show full history instead of just the latest.

## Data Source
No new tables. This reads:
- `task`: `source_type`, `source_ref`, `input_text`, `source_task_id`,
  `status`, `summary`, `cost_usd`.
- `tool_invocation`, `model_invocation`, `task_step`, `approval_request`,
  `audit_event`, `code_change` — via `@marathon/observability`'s
  `getTaskTimeline`/`getTaskReport`, which already assemble and tenant-scope
  these (`packages/observability/src/timeline.ts`).
- `Database.findTaskBySourceTask`, `countTasksBySourceTask`,
  `findLatestTaskByThread`, `findActiveRevisionTask` (`packages/db/src/index.ts`),
  plus the new list-variant reads noted above for full thread/PR history.

**Known limitation, stated explicitly rather than glossed over:** `model_invocation`
does not persist the raw prompt/response text sent to the model today — only
`provider`, `model`, `prompt_version`, token counts, cost, and latency. "Full
prompt/context" in this view therefore means (a) the verbatim triggering ask
(`task.input_text`) and (b) the assembled execution timeline, not a verbatim
transcript of every model message. Capturing raw model I/O would need a schema
change and its own redaction/retention review — out of scope here; flagged as
a possible follow-up, not silently assumed.

## Where Does This Page Live?
Since Marathon currently has no web UI, this is a read-only HTTP endpoint (two
routes: the list and the per-task detail), as a new small package or folded
into an existing app. Both routes reuse the tenant-scoped reads described
above (`getTaskTimeline`/`getTaskReport` already refuse to assemble data
across tenants — see the tenant check in `timeline.ts`); the endpoint's own
job is just to resolve which tenant is asking and pass that through, never to
broaden the scope. It binds to localhost by default — v1 has no auth story,
so no external exposure.

## User Interface Design
- **List page**: a plain table (tool id, time, status, error, owning task
  link). Server-rendered HTML, no client framework.
- **Detail page**: sections for Trigger, Prompt, Timeline, Related Tasks, as
  described above, plain HTML.
- **Non-Goals** (explicit, v1 pragmatic-minimalism cuts):
  - Real-time updates (WebSocket/SSE) — a page refresh is acceptable.
  - Filtering and sorting controls.
  - Free-text search across tasks or threads.
  - Cross-tenant thread merging.
  - Editing or replaying a past command.
  - Verbatim model prompt/response transcript capture (see limitation above).
  - Pagination beyond a bounded recent window.

## Redaction
Command argv/output (`tool_invocation.input_summary`/`output_summary`),
`task.input_text`, and any other free-text field rendered by either page
(including on the detail page's Prompt and Timeline sections) must go through
the existing `redactSecrets` (`@marathon/core`) before being sent to the
browser. This is a strict requirement, not an afterthought, and applies
uniformly to both routes.

## Verification
- `pnpm typecheck`
- `pnpm test`
- New unit tests covering:
  - List-page rendering redacts a planted secret in `input_summary`/`output_summary`.
  - Detail-page rendering redacts a planted secret in `input_text`.
  - Detail-page timeline rendering matches `getTaskTimeline`/`getTaskReport` output for a fixture task.
  - Related-tasks section returns the correct chain ancestors/descendants (`source_task_id`) and thread/PR siblings for a fixture set of tasks.
  - Tenant isolation: a request for a task in another tenant returns nothing (mirrors the existing check in `getTaskTimeline`).

## Next Steps
- Confirm the exact host package/route names during implementation.
- Confirm the list-variant thread/PR query shape (single query with an
  `order by created_at` vs. reusing the existing single-row lookups) during
  implementation — a detail, not a design blocker.

## Conclusion
This gives operators the full chain — trigger → prompt → execution timeline →
result → related tasks/threads — entirely from data Marathon already records,
with no new storage, tenant isolation preserved, redaction enforced, and scope
held to what a read-only, localhost-bound page can responsibly do in v1.
