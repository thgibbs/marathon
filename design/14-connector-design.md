# 14. Connector design

## 14.1 Connector interface

Each connector should provide:

```text
metadata
auth setup
available tools
permission scopes
health check
rate limit behavior
tool execution
output normalization
redaction rules
capability profile        # see below — drives the default write mode
```

### Capability profile (security model → product model)

Connectors differ in how safely they can be automated. Rather than encode this per-tool, each
connector **declares a capability profile** that maps to a **default write mode** (§7.8). This
turns "how do I run this connector safely" into a small, inspectable product decision instead of
hand-written policy:

```text
supports_scoped_credentials:       yes | partial | no
supports_resource_permissions:     yes | partial | no   # branch protection, roles, etc.
supports_native_review:            yes | partial | no   # a PR/draft-equivalent
supports_rollback:                 yes | partial | no
supports_external_audit:           yes | partial | no
credential_lifetime:               short | long | static
max_blast_radius_if_misconfigured: low | medium | high
default_write_mode: autonomous | native_review | in_app_approval | disabled
```

| Connector maturity              | Default write mode                       |
| ------------------------------- | ---------------------------------------- |
| Strong native scoping + review  | capability-only / native handoff         |
| Strong scoping, weak review     | capability + selective approval          |
| Weak scoping, strong review     | native handoff, no direct mutation       |
| Weak scoping, weak review       | Proposed Effects only / no autonomous writes |

GitHub is the happy path (scoped App creds + branch protection + PR review). Slack is medium
(scopes, weak native review). Internal APIs start pessimistic — reads scoped+audited, writes
gated — never arbitrary "HTTP call with a bot token." See [`policy.md`](../policy.md) §11.5 and
high-risk effects via **Proposed Effects** (§7.9).

---

## 14.2 GitHub connector

MVP tools:

```text
github.search_repos
github.search_issues
github.read_issue
github.read_pull_request
github.search_code
github.list_recent_commits
github.create_issue
github.comment_on_issue
github.submit_code_changes   # the BUILD→DELIVER handoff (§29) — the gateway reads the diff from the workspace
```

Effect classification (multi-axis, §7.8 — the single risk column is retired):

| Tool              | Axes                      | Default mode |
| ----------------- | ------------------------- | ------------ |
| search_repos      | read                      | autonomous   |
| read_issue        | read                      | autonomous   |
| read_pull_request | read                      | autonomous   |
| search_code       | read                      | autonomous   |
| create_issue      | reversible, repo audience | autonomous¹  |
| comment_on_issue  | reversible, repo audience | autonomous¹  |
| submit_code_changes | reversible, native review (§29.9) | native review (PR merge) |

¹ Routed by the tenant's egress policy (§7.8, §12.2 — default **on-behalf-of**): autonomous
when the requesting user has access to every sensitive source the task read; **denied** when
they lack it or it can't be determined (an approver cannot extend the requestor's access).
Writes to public repos derived from restricted sources route to a proposal in every mode.

---

## 14.3 Database connector

Initial design should be conservative.

MVP tools:

```text
database.describe_schema
database.query_readonly
database.explain_query
```

Rules:

* Read-only **by construction**: connect with a read-only database role (resource-native enforcement — `policy.md` §11.1), not just a query filter
* Query timeout
* Row limit
* Deny `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER` (defense-in-depth on top of the read-only role)
* Query allowlist option
* Sensitive column redaction
* Audit every query

---

## 14.4 Slack connector

Tools:

```text
slack.read_thread
slack.read_channel_recent
slack.post_thread_reply
slack.post_ephemeral
slack.add_reaction
slack.post_canvas
```

Rules:

* Respect channel membership
* Avoid reading private channels unless explicitly authorized (least-privilege reads — §12.2)
* External / Slack Connect channels and broad mentions (`@channel`/`@here`) always route to a `propose_effect` (§7.9); posts to internal channels — in or out of the originating thread — are routed by the tenant's egress policy (§7.8, default **on-behalf-of**)
* Rate-limit progress updates

---

## 14.5 Tool sources: built-in connectors and MCP

Marathon supports tools from more than one source. MCP is **one** form of tool, not the only one.

* **Built-in connectors** (GitHub, Slack, database, documents, …) are first-party, are *not* MCP servers, and ship with the best UX, docs, and permission models.
* **Command-line tools** are a **primary** tool choice — agents can run approved CLIs directly (Pi's built-in `bash` tool provides this, under the §7.8 policy hook). Many tasks are easiest to express as a command.
* **MCP servers** are how customers bring their *own* tools and connect them to Marathon, reusing the existing MCP ecosystem with low development burden.

All three kinds of tool are exposed to agents through Pi's single tool interface, and **all execute through the same `ToolGateway`** — the mechanical chokepoint (credentials, read ledger, egress routing, redaction, audit) applies uniformly regardless of tool source (§7.8).

Risks of MCP:

* Tool quality varies
* Security policies still needed
* MCP tools execute through the `ToolGateway` like any other tool — same credentials, read ledger, egress routing, redaction, and audit

Design rule:

> Whatever the tool source — built-in or MCP — every call executes through Marathon's gateway, under the same credential scoping, egress policy, and audit.

---

## 14.6 Document connector (GitHub markdown)

The first document surface and document-production capability are served by the **GitHub connector**: documents are markdown files in a repository, and comments/mentions ride on pull-request, issue, and review comments. Other providers (Google Docs, Notion, …) can be added later behind the same `document.*` interface, on request.

Tools:

```text
document.read              # read a markdown file
document.read_region       # read a section / diff hunk
document.create            # new markdown file (via branch + PR)
document.update            # edit a markdown file (via branch + PR)
document.comment           # comment on a PR / issue / file
document.reply_to_comment  # reply in a comment thread
```

Effect classification (multi-axis, §7.8):

| Tool                   | Axes                      | Default mode             |
| ---------------------- | ------------------------- | ------------------------ |
| read / read_region     | read                      | autonomous               |
| comment / reply        | reversible, repo audience | autonomous¹              |
| create (opens a PR)    | reversible, native review | native review (PR merge) |
| update (opens a PR)    | reversible, native review | native review (PR merge) |

¹ Routed by the same egress policy as §14.2.

Rules:

* Prefer comment replies over body edits.
* Body edits are proposed as pull requests (or review suggestions) — **native review**: the human merge is the approval (§7.8) — and re-validate the git SHA first (§11.3).
* Enforce repository permissions for both the user and the agent (§12.3); add user-impersonation only when a future provider needs finer-grained per-document ACLs.
* Support templates for produced documents (postmortem, PRD, release notes).
