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
```

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
```

Risk levels:

| Tool              | Risk   |
| ----------------- | ------ |
| search_repos      | Low    |
| read_issue        | Low    |
| read_pull_request | Low    |
| search_code       | Medium |
| create_issue      | High   |
| comment_on_issue  | High   |

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

* Read-only by default
* Query timeout
* Row limit
* No `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`
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
* Avoid reading private channels unless explicitly authorized
* Avoid posting outside the invoking thread without approval
* Rate-limit progress updates

---

## 14.5 Tool sources: built-in connectors and MCP

Marathon supports tools from more than one source. MCP is **one** form of tool, not the only one.

* **Built-in connectors** (GitHub, Slack, database, documents, …) are first-party, are *not* MCP servers, and ship with the best UX, docs, and permission models.
* **Command-line tools** are a **primary** tool choice — agents can run approved CLIs directly (Pi's built-in `bash` tool provides this, under the §7.8 policy hook). Many tasks are easiest to express as a command.
* **MCP servers** are how customers bring their *own* tools and connect them to Marathon, reusing the existing MCP ecosystem with low development burden.

All three kinds of tool are exposed to agents through the **same tool layer in the Pi harness**, which enforces Marathon's permissioning uniformly regardless of tool source.

Risks of MCP:

* Tool quality varies
* Security policies still needed
* MCP tools run through the Pi harness tool layer, which enforces Marathon’s permissioning

Design rule:

> Whatever the tool source — built-in or MCP — Marathon owns permissioning, approval, logging, and policy enforcement.

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

Risk levels:

| Tool                   | Risk         |
| ---------------------- | ------------ |
| read / read_region     | Low          |
| comment / reply        | Low–Medium   |
| create (opens a PR)    | Medium       |
| update (opens a PR)    | High         |

Rules:

* Prefer comment replies over body edits.
* Body edits are proposed as pull requests (or review suggestions), require approval, and re-validate the git SHA first (§11.3).
* Enforce repository permissions for both the user and the agent (§12.3); add user-impersonation only when a future provider needs finer-grained per-document ACLs.
* Support templates for produced documents (postmortem, PRD, release notes).
