# 7. Functional requirements

## 7.1 Slack surface integration

Slack is the first **surface** (see §7.16 for the surface abstraction and §7.17 for the document surface). The requirements below are specific to the Slack surface; equivalent capabilities are expected of every surface.

### Required

* Install Marathon as a Slack app.
* Receive `app_mention` events.
* Receive direct messages.
* Read thread context when authorized.
* Reply in thread.
* Post progress updates.
* Add feedback controls.
* Support task status command.
* Support agent discovery.

(User-initiated cancellation is deferred — see §15.4.)

### Recommended Slack commands

```text
/marathon agents
/marathon status
/marathon feedback
/marathon help
```

### Invocation styles

**Decision: a single Slack bot user.** Users invoke agents by naming them after `@marathon`:

```text
@marathon bruce investigate this
@marathon ada review this PR
@marathon investigate this          # no agent named → Marathon picks a default
```

This avoids the impression that each agent is a separate Slack app, keeps installation and permissions simple, and lets Marathon route to a **default agent** when none is named (based on task type and agent capabilities — see §7.3).

A single message creates at most **one** invocation, no matter how many `@marathon` mentions it contains — the first mention resolves the agent; the rest are plain text. Thread-level concurrency is defined in §7.4.

The backend still models agents as named aliases, so a future move to per-agent `@mentions` remains possible, but it is not a goal now.

---

## 7.2 Agent registry

Marathon needs a registry of available agents. Initially the registry is populated from the
deployment's **YAML agent definitions** (§6.2) at startup — no GUI or API creation path;
changing an agent means editing config and redeploying. A config change that alters an agent
produces a new **`AgentVersion`** row (keyed by config hash) on load, so task attribution and
`prompt_version` reproducibility (§7.18, §10.4) survive file-based authoring.

Each agent should have:

* Name
* Display name
* Description
* Owner
* Status
* Version
* Instructions
* Model policy
* Tool permissions
* Allowed Slack workspaces
* Allowed channels
* Allowed users/groups
* Memory policy
* Approval policy
* Budget policy
* Evaluation suite
* Visibility settings

Agent states:

```text
draft
active
disabled
archived
deprecated
```

Agent version states:

```text
draft
testing
published
rolled_back
deprecated
```

---

## 7.3 Agent discovery

Users should be able to discover agents from Slack.

Example:

```text
/marathon agents
```

Response:

```text
Available agents:

@bruce
Engineering investigation agent.
Can use: GitHub, logs, runbooks.

@ada
Code review assistant.
Can use: GitHub PRs, repo search.

@grace
Data analysis assistant.
Can use: analytics warehouse, dashboards.
```

Admin UI should support richer discovery:

* Search agents
* Filter by team
* Filter by tool access
* See owners
* See usage
* See feedback score
* See cost
* See recent failures

**Default agent selection.** When a user invokes `@marathon` without naming an agent, Marathon should auto-select an agent based on the task type and the agents' declared capabilities, and tell the user which agent it chose. Because agents differ in tool grants, default-agent selection is **security-relevant**: the default agent must carry a **conservative grant set** (read-mostly; egress to the originating surface only), and mis-routing must never land on a more-privileged agent than an explicit mention would have.

---

## 7.4 Task lifecycle

Every invocation — from any surface (Slack, a document, the web console, the API) — should create a task.

Task states:

```text
created
queued
running
waiting_for_input
waiting_for_approval
retrying
completed
failed
cancelled
expired
```

Task events:

```text
task.created
task.queued
task.started
task.step.started
task.model.called
task.tool.called
task.approval.requested
task.approval.granted
task.approval.rejected
task.feedback.received
task.completed
task.failed
task.cancelled
```

Task requirements:

* Persist every task.
* Persist every step.
* Store intermediate outputs.
* Store tool call summaries.
* Store model call metadata.
* Support retries (automatic for transient failures; see §11.4).
* Support timeout.
* Support resumption.
* Support replay in dev/test mode.
* Support task ownership and visibility checks.

### Concurrency

* **One message → one task.** A message creates at most one invocation regardless of how many
  `@marathon` mentions it contains (§7.1); the first mention resolves the agent.
* **Same thread, separate messages → parallel tasks.** Each mention is its own durable task;
  they run **concurrently**, and each task's context bundle (§7.18) includes the thread — so a
  later invocation sees the earlier one's presence and any progress or results already posted.
* **No platform-level serialization.** If an agent needs another task's result before
  finalizing, it waits the way it waits for anything else (§11.6): monitor via a read-only
  `get_task_status` governed tool (subject to the task-visibility checks above), or end the
  turn and resume when the thread updates. Concurrent writes stay safe via idempotency keys
  and base-SHA validation (§11.3).

---

## 7.5 Long-running execution and agent harness

Marathon should use durable async execution.

Required capabilities:

* Queue-backed execution
* Worker leases
* Heartbeats
* Step checkpointing
* Retry policies
* Dead-letter queue
* Idempotency keys
* Human approval waits
* Recoverable task state

A long-running task should not be stored only in process memory.

### Agent harness (Pi)

Agent steps run inside an **agent harness** behind the **`AgentRuntime`** seam. Two
harnesses are supported — **one or the other**, selected per deployment with a per-agent
override (`harness: pi | claude-code` in the agent YAML, §6.2):

* **Pi** (`@earendil-works/pi-coding-agent`), embedded **in-process** in the worker via its
  SDK — see `pi-details.md` for the full integration reference.
* **Claude Code (headless)** — the `claude` CLI in print mode (`claude -p --output-format
  stream-json`), run as a **subprocess inside the sandbox** (roadmap **K7**) — see
  `claude-code-impl.md` for the full integration reference. **One harness turn = one
  print-mode invocation**, resumed between turns via `--resume <session-id>`; each
  invocation is bounded with `--max-turns` so long BUILD runs checkpoint on a fixed cadence
  rather than running unbounded (the K4 contract, §11.2).

The harness owns the in-task agent loop — prompting, tool calling, step sequencing, progress
emission; Marathon owns everything around it.

Requirements:

* The harness runs *inside* the durable Agent Worker, behind `AgentRuntime`. Marathon owns
  durability around it (queueing, leases, checkpoints, resumption, idempotency); the harness
  owns the agent loop. Whichever harness runs, **the gateway stays the chokepoint and the
  session stays the checkpoint**.
* **The `ToolGateway` is the chokepoint; Pi is only the loop.** Marathon registers each tool
  as a Pi **custom tool that delegates to the `ToolGateway`** (credential injection, the
  source-sensitivity read ledger, egress routing, audit, redaction, tenant isolation; a
  **deterministic safety perimeter**, not a policy engine — §7.8). High-risk effects are not direct tools: the model calls `propose_effect` and a non-model
  executor acts (**Proposed Effects**, §7.9). Pi's **built-in** tools (`read/grep/find/ls`) bypass the gateway, so
  they are now **off by default** (`PiAgentRuntime.builtinTools`, default none) and enabled only
  inside a sandboxed workspace (§12.6); the `tool_call` hook remains the path to fully govern
  them when running Pi-in-sandbox (see §7.8, §12.6, `pi-details.md` §3 As-built).
* **Claude Code maps to the same chokepoint over MCP.** Marathon's governed tools are served
  to the harness as **one stdio MCP server (`marathon-mcp-shim`) that forwards every call to
  the host broker** — a per-task unix socket served by `serveToolBroker` and backed by
  `gateway.run` — so validate → policy → ledger → egress → credential-injected execute →
  redact → audit all run host-side, and tool results enter the container (and therefore the
  session JSONL) **already redacted**. The MCP config is passed with `--strict-mcp-config`
  so a checked-in `.mcp.json` in the untrusted workspace can never add servers. Built-in
  file/bash tools are naturally contained because the whole process runs inside the sandbox
  (Pattern 1, §12.6); sub-agents are disabled via the harness's allow/deny lists and a
  Marathon-managed settings file, and network built-ins follow the agent's egress posture
  (`sandbox.network`, §12.6 — `WebFetch` only under `bridge`; `WebSearch` executes
  server-side through the model API, so it works in either posture) — all
  **defense-in-depth, never the boundary** (§12.6). The model call exits the sandbox only
  through a **host-side key-injecting proxy** (`ANTHROPIC_BASE_URL`), so no API key enters
  the container.
* **The harness session (a resumable JSONL — Pi session or Claude Code session) is the
  durable agent checkpoint and the full trace.** Persist it per task; it powers crash-resume,
  the inspectability dashboard, and replay (see §11, §16). Under Claude Code the live JSONL
  is written **inside the workspace home** (`CLAUDE_CONFIG_DIR` under
  `/workspace/.marathon-home`, which the workspace manager already excludes from the repo's
  git view) — host-visible for per-turn snapshots, and structurally unable to ride the diff
  into a PR (§29.4 reads only the repo view).
* Pi provides model-call **logging, retries, and redaction**, plus per-model **cost metadata**,
  which keeps Marathon's Model Gateway minimal (see §9.2, §13). *As-built:* per-call cost is
  read from the turn's assistant message (`usage.cost.total`); budgets are enforced from
  actuals in the step runner (M8). Claude Code reports cost/usage in its `stream-json` result
  event, captured into the same `ModelInvocation` records; because one of its harness turns
  can span many internal model turns, the runtime also accumulates streamed per-message
  usage and kills the run on budget breach mid-invocation (§13.3).
* **Neither harness sandboxes itself** — Marathon supplies OS-level isolation (§12.6):
  **Pattern 2** for Pi (tool execution routed into the container) and **Pattern 1** for
  Claude Code (the harness itself runs in the container).

---

## 7.6 Feedback system

Feedback is intentionally simple: **thumbs up or thumbs down, with optional free text.**

```text
thumbs_up
thumbs_down
free_text   # optional comment attached to either
```

Feedback sources (capture mechanism varies by surface; feedback *types* are surface-agnostic):

* Slack reaction or button
* Document comment resolution or 👍
* Slash command
* Admin UI / web console rating
* API

Feedback should be queryable by:

* Agent
* Agent version
* User
* Tenant
* Model
* Tool
* Time range
* Feedback type
* Task type

Feedback is **incorporated into memory and future context** (§7.12): a correction is written **user-scoped** (tagged with the agent for ranking) and can be promoted to project or tenant scope under §7.12's write gates — so an agent stops repeating a corrected mistake without the correction becoming a tenant-wide injection channel. Feedback can also be promoted by the team into eval cases (§17).

---

## 7.7 Connectors and tools

Marathon should separate **connectors** from **tools**.

A connector is the integration with an external system.

Examples:

* GitHub connector
* Slack connector
* Postgres connector
* Datadog connector
* Google Drive connector

A tool is a specific callable capability exposed to agents.

Examples:

```text
github.search_repositories
github.read_pull_request
github.comment_on_issue
postgres.query_readonly
datadog.query_logs
slack.read_thread
slack.post_message
```

This separation matters because one connector may expose many tools with different risk levels.

Tools are exposed to the agent loop through Pi's single tool interface, but **every governed call executes in Marathon's `ToolGateway`** — each tool is registered as a Pi custom tool whose `execute` delegates to the gateway (§7.8). Pi runs the loop; the gateway does the mechanical work (credentials, read ledger, egress routing, redaction, audit); *what a tool can do* is bounded by credential scope and the resource's own permissions. **Command-line tools are a first-class, primary tool type** alongside built-in connectors and MCP servers (see §14.5).

---

## 7.8 Tool permissioning

Tool calls are made from the Pi loop, but **the chokepoint is Marathon's `ToolGateway`** — a host-side component the model can neither bypass nor rewrite. Each Marathon tool is registered as a Pi **custom tool whose `execute` delegates to `gateway.run`** (validate → record the read in the sensitivity ledger → inject credentials → execute → redact → audit, with egress routed per below). The gateway does **plumbing, not permissions**: *what an agent may do* is enforced by credential scope, resource-native permissions, and the egress policy; *which tools it has* is fixed at construction time (registration). The originally-planned `tool_call`/`tool_result` hook (see `pi-details.md` §3) is equivalent and additionally covers Pi's **built-in** tools — which the custom-tool approach does not govern, and which are therefore off by default and sandbox-routed (§12.6). Two practical constraints learned in build: model-facing tool names must match `^[A-Za-z0-9_-]+$` (no dots — sanitized + mapped back), and only Marathon-registered tools flow through the gateway.

Under the **Claude Code harness** (§7.5) the same chokepoint holds with a different
transport: governed tools are served to the harness as an **MCP server backed by
`gateway.run`** (over the host broker), ungoverned built-ins are disabled via the harness's
allow/deny lists, and file/bash execution is contained by running the harness itself inside
the sandbox (Pattern 1, §12.6).

Each tool should declare:

* Name
* Description
* Input schema
* Output schema
* Risk axes (reversibility / trust-boundary / audience / cost — see below)
* Required credentials
* Required scopes
* Default mode (autonomous | native_review | proposed_effect | disabled)
* Rate limits
* Timeout
* Retry policy
* Logging policy
* Redaction policy

**The gateway is a deterministic safety perimeter, not a policy brain.** It performs only
mechanical, declarative checks — tenant↔credential isolation, allowed connector/repo/channel for
the task, branch-name prefix, max diff size, no direct write to protected branches, rate/budget
caps, schema validation, secret redaction, audit logging, and an emergency kill switch. It does
**not** decide business permissions in a programmable way; a routing DSL would just recreate the
policy engine we deliberately avoid (see `policy.md`). Enforcement of *what an agent can do at all*
lives in two stronger places: the **credential's scope** (least-privilege, tenant-owned bot/app
creds) and the **resource's own permissions** (GitHub branch protection / repo roles, doc
permissions, DB roles). The model itself never holds high-risk capability — see **Proposed
Effects (§7.9)**.

**Risk model (retires the single `destructive` boolean).** An effect is classified on several
axes, not one flag:

```text
reversibility:  can it be undone?            (edit a draft  →  delete a record)
trust-boundary: does it move info from a higher-trust source to a lower-trust sink?  (exfil axis)
audience:       private thread  →  team channel  →  external / public
cost:           does it spend money or scarce resources?
```

The **primary threat is exfiltration / confused deputy** — read-private-A → write-lower-trust-B
(e.g. summarize a private repo into a public channel), which is *non-destructive* yet the worst
realistic prompt-injection outcome. Gating writes does not fully close it, so **least-privilege
reads** and redaction matter as much as write controls (§12.1–§12.2).

**Egress policy (how the trust-boundary axis is evaluated).** Blanket-gating every reply that
touched a private source would make agents useless inside a company (and breed approval
fatigue); letting anything flow anywhere makes exfiltration trivial. So *internal* disclosure is
routed by a tenant-configurable **egress policy** — deterministic access checks over static
metadata, never a content classifier:

| Mode | An internal post/reply/write runs autonomously when… |
| --- | --- |
| `open` | always — the tenant treats all internal audiences as equivalent |
| `on-behalf-of` (**default**) | the **requesting user has access to every sensitive source the task read** — the agent may say to an internal audience what the requestor could have said themselves |
| `audience` (strict) | the **destination audience** can see every sensitive source (the source-vs-audience check) |

* **On-behalf-of verifies access, not credentials.** The task still runs on tenant service
  credentials (§12.3); Marathon *checks* the requestor's access to each sensitive source (e.g.
  their GitHub repo permission) via their linked identity — OAuth-proven, never typed
  (§7.20, §10.2).
* **No access → denied, not proposed.** An approver must not be able to extend the requestor's
  access — that grant belongs to the source system (GitHub, the database, …). The denial is a
  **platform-generated notice** (never a model-written reply, which could itself leak), telling
  the user why and how to request access. **Indeterminable identity or access is denied too**,
  with a **"Link your GitHub" CTA** that starts the §7.20 OAuth linking flow. Prefer enforcing at **read time** — under on-behalf-of a task
  should not read sensitive sources the requestor cannot access (least-privilege reads, §12.2);
  the egress check is the backstop. (`audience`-mode failures, by contrast, route to a
  proposal: *may this content reach this audience* is a judgment an authorized approver can
  make; *does the requestor have access* is not.)
* Source sensitivity is static metadata from the connector's read-side capability profile
  (§14.1, `policy.md` §11.5) and resource visibility (public / company-viewable / restricted
  repo; public / private channel). A tenant may mark company-viewable sources as free to flow
  to any internal audience under every mode. **Initial calibration: all repos are
  `company-viewable`** until a customer needs finer tiers — so at first the internal deny
  path exercises only for sources marked more sensitive (none by default), and
  tenant-external egress remains the binding gate.
* **Recalled memory counts as a source.** Each memory scope recalled into the prompt (§7.12)
  enters the sensitivity accounting like a document read — a task that recalled project-scoped
  memory and then egresses beyond the project trips the check. Recall itself is audience-gated
  at prompt-build (§7.12); this is the backstop.
* **Always a proposal, in every mode:** egress that leaves the tenant boundary — external or
  Slack Connect channels, email to external recipients, public artifacts derived from
  restricted sources — plus broad mentions (`@channel`/`@here`).
* **Residual risk, stated:** under `open`/`on-behalf-of`, an injected task can disclose to an
  internal audience broader than the sources' — the same disclosure the requestor could have
  made by hand. Mitigations: attribution, audit, the post's reversibility, least-privilege
  reads.

*Worked example:* Tanton asks Bruce in `#incidents` to investigate checkout errors; Bruce reads
the private `checkout-api` repo and Datadog. Tanton has access to both → the threaded findings
reply is **autonomous** under on-behalf-of (§6.3 works as written). If a user without repo
access asked the same question, the task would be scoped away from the repo at read time — or
its reply **denied** with a platform notice; an approver cannot extend access the requestor
lacks.

Each effect's default handling is a function of those axes **plus the connector's capability
profile** (§14.1):

| Default mode        | When                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| **Autonomous**      | reversible, no trust-boundary crossing, bounded audience (read, create branch, open PR, reply in the originating thread) |
| **Native review**   | a native draft/review surface exists — prefer it (open a PR, human merges) |
| **Proposed Effect** | high-risk (irreversible, cross-boundary, public/external, or costly) → `propose_effect` (§7.9) |
| **Disabled**        | connector lacks scoping *and* review, or admin has not enabled it          |

> **Approval fatigue is a design force.** Humans rubber-stamp at volume. Minimize how often a
> human is asked: maximize native handoff + autonomous-safe, and treat in-app approval as rare.

---

## 7.9 Proposed Effects (propose → review → execute)

**The model does not get high-risk tools; it gets a tool to *propose* an external effect.** A
separate, deterministic **executor** — never the model — performs approved effects using scoped
tenant-owned credentials. This preserves capability-by-construction (the model can't hold the
dangerous power) while giving a review boundary for effects that a native surface can't safely
express. Rationale and options are in [`policy.md`](../policy.md).

Reversible, bounded actions still run **autonomously** through the gateway (read, create branch,
open PR, status replies in the originating thread — §7.8). **Being in the originating thread is not
itself a safe-pass:** a reply carrying private repo/doc/email context to a broader audience is
egress, routed by the tenant's **egress policy** (§7.8) — deterministic access checks, **not** a
content classifier. Under the default **on-behalf-of** mode it runs autonomously when the
requesting user has access to every sensitive source the task read; without that access it is
**denied** (an approver cannot extend the requestor's access — §7.8). Proposals are reserved
for effects a human may legitimately authorize. High-risk
effects (irreversible, cross-trust-boundary, public/external, or costly) are **never direct tools**;
the model calls:

```text
propose_effect(
  effect_type,      # slack_post | email_send | doc_delete | github_merge | internal_api_call | …  (typed per connector)
  target,           # destination / resource
  payload,          # the EXACT proposed content or mutation
  source_context,   # provenance: what the agent read to produce this
  risk_reason,      # model's justification
  rollback_plan?,   # optional
  idempotency_key
)
```

**`propose_effect` is an ordinary async tool call — it never blocks the agent.** It enqueues
the proposal onto a durable queue (Temporal-shaped; ours is the Postgres queue, §18.2) and
returns immediately with a handle:

```text
{ effect_id, execution_state: "proposed", monitor: get_effect_status(effect_id) }
```

The agent monitors via `get_effect_status` (a read-only governed tool), continues other work,
or simply reports the pending proposal and ends its turn. When the workflow resolves the
proposal, the **executor** performs the approved artifact and the task is **continued with the
outcome as a new turn** (§11.6) — the model never waits mid-call, and never re-executes the
effect itself.

A **workflow** routes each proposal **declaratively**. It may evaluate static metadata and
deterministic predicates (connector, effect type, destination, audience, sensitivity label, payload
size, cost, reviewer role) — but is **not** a programmable policy engine: auto-approve → convert to
a native draft/review artifact → in-app approval → deny. Where a native surface exists (a PR for
code), prefer it: the PR *is* the approval, in the human's existing workflow.

### Invariants (what makes this a boundary, not a rubber stamp)

1. **Approval binds to the concrete artifact** (exact message/diff/recipients/mutation, hashed) —
   never to an intention. If the payload changes, the approval is void.
2. **Immutable once review starts** — edits create a **new version**; approval applies to exactly
   one version; the executor runs only that version. An edit's author is recorded on the new
   version, and the audit trail distinguishes the artifact's **author** (model or human editor)
   from its **approver**.
3. **The model cannot execute** — it only enqueues; the executor performs the effect.
4. **The right principal approves** — from someone **authorized for the target resource, effect
   type, and blast radius**, not just any human (Phase 1: invoking user or a configured approver).
5. **Revalidate at execution** — tenant, credential, resource, destination, payload hash, and
   reviewer authority are all re-checked at run time.
6. **Idempotent / replay-protected** — an `idempotency_key` bounds execution to **at most once**
   unless the workflow explicitly supports safe retry.
7. **Approvals expire.**
8. **Provenance recorded and shown** — as decision support for the reviewer and for forensics,
   **not** as an automated taint-gate.
9. **Typed per-connector workflows** — no generic "do dangerous thing."

The proposal/effect record binds: `effect_id · task_id · tenant_id · connector_id · effect_type ·
payload_hash · proposal_version · provenance · reviewer_id (+authority) · approval_expiry ·
idempotency_key · execution_state` — all logged as audit events.

**Channels (M10)**, both backed by the same durable record:

* **In-line** — an Approve/Reject prompt in the originating surface (Slack), carrying a link to
  the hub; for the rare fast case.
* **Agent Hub (web UI)** — a queue of outstanding proposals rendering the *exact artifact* (diff /
  message / mutation), provenance, cost, and risk, with edit-then-approve.

For the MVP, approval scope is `this_action_only` (bound to the exact artifact).

---

## 7.10 Model routing

Model routing should be declarative. This section defines the **policy**; §7.19 defines the
runtime **selection procedure** that applies it per invocation/step.

Example:

```yaml
model_policy:
  default: openai:gpt-4o-mini
  reasoning: openai:gpt-4o
  cheap: openai:gpt-4o-mini
  embedding: openai:text-embedding-3-small

routing:
  classify_intent: cheap
  summarize_context: default
  plan_task: reasoning
  generate_final_answer: default
  safety_check: cheap
```

Routing inputs:

* Agent config
* Task type
* Cost budget
* Latency requirement
* Context length
* Required tool use
* User preference
* Tenant policy
* Provider availability

Required model metadata:

* Provider
* Model name
* Input tokens
* Output tokens
* Cost estimate
* Latency
* Error
* Retry count
* Prompt version
* Response hash

---

## 7.11 Cost tracking

Marathon should track cost at multiple levels:

* Per task
* Per agent
* Per tenant
* Per user
* Per model
* Per tool
* Per day/week/month

Admin controls:

* Hard budget
* Soft budget
* Alert threshold
* Per-agent budget
* Per-user budget
* Per-task max cost
* Disable expensive models by default
* Route spend above threshold to a proposal (cost is a risk axis — §7.8/§7.9)

Example policy:

```yaml
budget_policy:
  monthly_tenant_limit_usd: 500
  per_task_soft_limit_usd: 2
  per_task_hard_limit_usd: 10
  require_approval_above_usd: 5
```

---

## 7.12 Memory and context

Memory is what lets an agent carry context within a task, across a conversation, and over time
— and learn from feedback so it stops repeating corrected mistakes. How memory is *gathered
and composed into a prompt* is §7.18; this section defines *what memory is, how it's scoped,
and the swappable store behind it*.

> **External documents are not memory.** Intranet / RAG / MCP document access is a **tool
> read** of a resource with its own ACL — governed by the connector's read-side profile,
> least-privilege reads, and the on-behalf-of check (§7.8), like any other read. Retrieval
> indexes must be **permission-aware**: record each document's access specifier, filter at
> query time by the requestor's access (via linked identity — [[open-questions]] OQ-1), and
> re-check or short-TTL-sync ACLs so revocation holds. The memory store below holds only
> **generated** memory (learnings from previous interactions) and never ingests external
> documents — copying them in would flatten their ACLs.

### Dimensions: scope × term

Memory is organized along two axes.

**Scope** (who may see it) — each scope *is* an audience, nested user ⊂ project ⊂ tenant:

| Scope | Audience | Holds |
| --- | --- | --- |
| **Tenant** | the whole company | org-wide knowledge, conventions, policies |
| **Project** | the project's members (a **GitHub repo** for now; see below) | facts/decisions about one project |
| **User** | the one user | that user's context, preferences, and corrections from their own interactions |
| **Thread** | the thread's participants | working memory for one conversation (a Slack thread or document thread) |

**Agent is not an access scope.** A named agent (Bruce, Quill) is **relevance metadata**:
items may be tagged with the agent that learned them so recall ranks them higher for that
agent's tasks — but *access* is governed only by the audience scopes above. (The previous
agent scope crossed projects and users, which was a leak channel; retired.)

**Term** (how long it lives):

* **Short-term** — working memory (recent thread turns), TTL'd; ranked by recency.
* **Long-term** — durable knowledge (summaries, corrections, facts); ranked by relevance.

> **Task-local memory is not in the store.** A single task's working state (plan, tool
> results, intermediate summaries) is already the durable **Pi session + checkpoint** (§7.5,
> §11.2). The memory store's short-term tier is **thread-level** (spanning the tasks in one
> conversation), so we don't duplicate the durable spine.

### Recall is audience-gated

A scope is recallable iff the **task's audience is contained in the scope's audience** —
memory never enters a prompt whose output will reach people who couldn't see that memory's
scope. Because the requestor is always in the audience (they see the reply), this is strictly
stronger than the on-behalf-of check (§7.8); the two models agree.

| Invocation context | Recallable scopes |
| --- | --- |
| DM with the agent | user + the user's projects + tenant |
| Project channel / repo PR or file comment | project + tenant |
| General internal channel | tenant only |
| Channel with external/guest members | none¹ |

¹ Exception: a task *drafting* an external artifact may recall **tenant** scope, because
external egress is proposal-gated in every mode (§7.8) — a human reviews the exact artifact
before it leaves.

**Preference exception.** User-scoped items of kind `preference` (style/format — they steer
*how* the agent responds without disclosing content) are recallable wherever the user is the
requestor, even outside DMs. `content` items stay strictly audience-gated.

**Audience computation is deterministic** (no content classification): the GitHub surface uses
the repo's audience natively; Slack uses an **admin-declared channel ↔ project mapping** (the
assertion that a channel's membership is within the project), Slack's own external-shared /
guest flags, and DM detection. Unknown mapping → tenant scope only; external members present →
none (except the drafting exception). Per-member access checks (OQ-1) can replace the mapping
later.

**Recalled scopes count as sources.** Recall uses the audience *as computed at prompt-build*;
if the task later egresses to a broader audience, the egress policy (§7.8) treats each
recalled scope as a source read — recall-time is the primary enforcement, egress-time the
backstop.

Within the allowed scopes, a recall **unions them and both terms**, then ranks the merged set
(relevance blended with recency — agent tags boost relevance) within a token budget. Callers
ask "what's relevant here?" — they do **not** pick a term.

### Writes go to the narrowest scope, gated by breadth

A task that read restricted content must not launder it into broad recall. Rules:

* Write to the **narrowest applicable scope**; an item's scope must not be broader than the
  audience allowed to see its content (provenance sensitivity recorded per item).
* Write gating scales with the scope's audience — this is also the poisoning blast-radius
  model (§12.2):

| Scope written | Gate | Blast radius if poisoned |
| --- | --- | --- |
| **User** | none — self-affecting | the writer's own future tasks |
| **Thread** | none (short-term, TTL'd) | one conversation |
| **Project** | lightweight; project members can `list`/`forget` it | that project's tasks |
| **Tenant** | **requires confirmation** (agent owner / admin) | every task in the tenant |

### Project = GitHub repo (for now)

"Project" is a tenant-scoped grouping resolved from the invocation source. Initially a
**GitHub repo** (`owner/name`), resolved natively on the GitHub surface and via the
**admin-declared channel ↔ project mapping** on Slack; an explicit/generated `Project` can
replace it later via a pluggable **project resolver**, with no change to the store interface.
Project memory carries the repo's audience: recallable only where the task's audience is
contained in the project (above), and writable only by tasks whose requestor has repo access
(§7.17).

### The store is swappable — `MemoryStore`

Marathon does not hard-code a memory engine. All memory flows through a `MemoryStore`
interface; backends are adapters. This lets us start simple and graduate to a purpose-built
memory layer without touching the rest of the system.

```ts
type MemoryTerm = "short" | "long";
type MemoryLevel = "tenant" | "project" | "user" | "thread";  // audience scopes (agent is metadata, not a level)
interface MemoryScope { tenantId: string; projectId?: string; userId?: string; threadId?: string; }
interface TaskAudience { level: MemoryLevel; projectId?: string; userId?: string;  // computed at prompt-build
                         external?: boolean }                  // external/guest members present

interface MemoryItem {
  id: string; scope: MemoryScope; level: MemoryLevel; term: MemoryTerm;  // term set on write
  kind: string;           // summary | correction | preference | message | fact | ...
  agentId?: string;       // relevance metadata only — never an access filter
  provenance?: { taskId?: string; sensitivity?: string };      // what produced it, how sensitive
  text: string; metadata?: Record<string, unknown>;
  createdAt: Date; expiresAt?: Date;                           // short-term TTL
}

interface MemoryStore {
  remember(item): Promise<MemoryItem>;      // store enforces narrowest-scope + write gating
  recall(q: { query: string; scope: MemoryScope; audience: TaskAudience;  // audience-gates levels
              limit?: number; tokenBudget?: number }): Promise<MemoryItem[]>;  // searches both terms
  forget(filter: { id?: string; scope?: Partial<MemoryScope>; before?: Date }): Promise<number>;
  list(scope: Partial<MemoryScope>): Promise<MemoryItem[]>;
}
```

Each adapter maps Marathon's scope to its provider's keys:

| Backend | Role | Notes |
| --- | --- | --- |
| **pgvector** | default, in-repo | a `memory_item` table + embeddings; zero extra infra; keeps CI deterministic. Stores + retrieves, but is **not a memory *system*** (no fact extraction, dedup/conflict resolution, temporal reasoning, or decay). |
| **Mem0** | first external backend | a real memory layer; accessed as a service via its client SDK, not embedded in-process. Adds extraction/dedup when enabled. |
| **Zep / others** | future | temporal knowledge graph, behind the same interface. |
| **Letta / MemGPT** | not a fit | it owns the agent loop (Pi already does); borrow its tiered-memory ideas, don't adopt it as a store. |

Embeddings for the pgvector default use **OpenAI `text-embedding-3-small`**.

### What gets written (store-and-retrieve scope)

The first cut is **store-and-retrieve only** — no LLM fact-extraction or short→long
consolidation yet (added later, largely "for free" once Mem0 is wired):

* **Long-term** ← the task **result summaries** Marathon already produces (written to the
  task's **project** scope, or user scope for DM tasks — never tenant without confirmation),
  plus **feedback corrections**: a 👎 + correction becomes a **user-scoped** `correction` item
  (tagged with the agent for ranking), promotable to project scope by a project member or to
  tenant scope with agent-owner confirmation — this is the "feedback incorporated into future
  context" goal (§7.6), under the write gates above.
* **Short-term** ← **thread turns**, written with a TTL.
* Corrections **outlive agent versions**: on publishing a new `AgentVersion`, review the
  long-term corrections tagged with that agent — they may conflict with the rewritten
  instructions (§17.4).
* **Recall** is called by the prompt builder (§7.18) on each invocation, with the computed
  `TaskAudience`.

### Requirements (now enforced by the store)

* **Tenant-isolated**; recall **audience-gated** per the containment rule above; writes to
  the narrowest scope, tenant-scoped writes confirmed.
* Recalled scopes reported to the **egress policy** as sources (§7.8).
* **Inspectable** (`list`) and **deletable** (`forget`) per scope — for the dashboard (§16)
  and retention/erasure (§12.5).
* Configurable **retention**; short-term **TTL**; **redaction** of sensitive content (§12.2).
* **Optional by default** — an agent uses memory only if configured to.

> **Status.** Build status lives in the roadmap. **As-built (2026-07-03, migration Track
> 13 / roadmap §2b #9):** the store enforces this model — audience-gated recall
> (`TaskAudience` computed deterministically at prompt-build; user-`preference` exception
> included), user scope replacing agent scope (agent tag = ranking boost only), narrowest-
> scope writes with the tenant confirmation gate, and user-scoped corrections with gated
> promotion. Still open: the admin-declared Slack channel↔project mapping (each channel is
> its own pseudo-project for now), external/guest detection on Slack, and reporting recalled
> scopes to the egress ledger (lands with the M10 lattice).

---

## 7.13 Admin console

> Initial scope: internal. The admin console is operated by the Marathon team for now, not exposed to customers — except the **inspectability dashboard** (§5.5), which users and admins do see. Agent creation/editing is **not** in the console initially — agents come from YAML config (§6.2). Documented here for direction.

The admin console should include:

### Agent management

* Create agent
* Edit agent
* Publish version
* Roll back version
* Disable agent
* Configure prompts
* Configure model policy
* Configure tools
* Configure memory
* Configure approvals
* View usage
* View feedback

### Connector management

* Install connector
* Configure credentials
* Test connection
* Select scopes
* Select repositories/databases/projects
* Rotate credentials
* Disable connector

### Task history

* Search tasks
* Filter by agent
* Filter by user
* Filter by status
* View trace
* View tool calls
* View model calls
* View cost
* Retry task
* Cancel task
* Save as eval case

### Observability

* Task success rate
* Task latency
* Queue depth
* Tool error rate
* Model error rate
* Token usage
* Cost trend
* Feedback trend
* Top failing agents

### Security

* Audit log
* Approval log
* Secret redaction log
* Policy violations
* Permission changes
* Data retention settings

---

## 7.14 Developer CLI

> Initial scope: internal. The CLI is a Marathon-team tool for now, not a customer-facing surface. Documented for direction.

Marathon should include a CLI for developers.

Example commands:

```bash
marathon login
marathon agents list
marathon agents create
marathon agents test bruce
marathon agents publish bruce
marathon tools list
marathon connectors list
marathon tasks get TASK_ID
marathon tasks replay TASK_ID
marathon evals run bruce
marathon dev slack-event sample.json
```

The CLI should make local iteration fast.

---

## 7.15 Agent SDK

> Initial scope: there is **no agent SDK**. Agents are defined declaratively in YAML config (§6.2), changed by editing config and redeploying. The programmatic sketch below is future direction only.

The SDK should make simple agents easy and advanced agents possible.

Example conceptual SDK:

```python
from marathon import Agent, tool

agent = Agent(
    name="bruce",
    description="Engineering investigation agent",
)

@agent.instructions
def instructions():
    return """
    You investigate engineering issues.
    Use evidence. Be concise. Propose high-risk effects for review; never execute them directly.
    """

@agent.task("investigate_incident")
async def investigate(ctx):
    thread = await ctx.slack.read_thread()
    repos = await ctx.github.search(thread.summary)
    logs = await ctx.datadog.query(thread.time_range)

    return await ctx.respond(
        evidence=[thread, repos, logs],
        format="incident_summary",
    )
```

SDK requirements:

* Define agents
* Define tools
* Define task handlers
* Define model policy
* Define approval requirements
* Emit progress updates
* Access task context
* Read/write memory
* Register eval cases
* Run locally

---

## 7.16 Surface abstraction

A **surface** (or channel adapter) is any place a user can invoke an agent and receive results. **Slack and GitHub-backed markdown documents are both first-class surfaces from the beginning**; the web console, email, the API, and schedulers follow later.

Every surface implements a common interface:

* Identity resolution (external user → Marathon user)
* Invocation parsing (raw event → normalized invocation)
* Context loading (surface-native context: a thread, a document region)
* Acknowledgement (fast "I started")
* Progress emission
* Approval prompts (rendered in the surface)
* Final delivery (render the structured result where it belongs)
* Feedback capture

The core task engine must know nothing about any specific surface. Surface-specific identifiers live in the task's `source_ref`, not in core columns (see §10.8).

---

## 7.17 Document surface integration

Documents are a first-class surface, in two modes. The first implementation is **GitHub-backed markdown**: markdown files in a repository, with pull-request, issue, and review comments as the comment/mention channel. Other providers (Google Docs, Notion, …) can be added later on request, behind this same interface.

### Producing documents

* Agents create and update markdown documents via `document.*` tools (see §14.6), through the `ToolGateway` and the effect-routing model (§7.8). On GitHub this means committing to a branch and opening a pull request.
* Output is a **structured result** (summary, evidence, recommendation, actions, open questions) rendered into markdown using an optional, versioned template (e.g. postmortem, PRD, release notes).

### Being tagged into documents

* Users summon an agent with an `@mention` in a comment or review, anchored to a file or region (path, line range, or comment id).
* Context loading pulls the relevant region (the file, the diff hunk, or surrounding section, per policy and size).
* The agent replies as a **comment reply by default**; editing document *body* content is a write action that defaults to requiring approval (proposed as a pull request or review suggestion).

### Required

* Detect `@mentions` via GitHub webhooks (`issue_comment`, `pull_request_review_comment`).
* Resolve and store the document anchor (repo, path, line/comment id) in `source_ref`.
* Read document regions with permission checks.
* Post comment replies.
* Create/update documents behind approval (as pull requests).
* Handle concurrent edits: capture the git blob/commit SHA seen, include it in the idempotency key, and re-validate (or rebase) before any write (see §11.3).

### Permissions

Document access is governed by the **repository's permissions**, enforced through the GitHub connector — check that both the invoking user and the agent may access the repo before reading or writing. If a future provider has finer-grained per-document ACLs (e.g. Google Docs), user-impersonation credentials let the agent inherit the invoking user's access (see §12.3, §22.2).

---

## 7.18 Prompt & context assembly

Every invocation — a Slack mention, a document comment — must be turned into a concrete model
prompt. This is the **prompt builder**: the link between the *static* agent configuration
(§7.2, §10.4) and the *dynamic* agent loop (§7.5). It runs once at the start of a task (and
may re-run per step), is the same across surfaces by contract, and is surface-specific only in
*which context it gathers*.

### Layers of the assembled prompt

The builder produces a layered prompt with a strict trust gradient (most trusted first):

1. **Instructions layer (trusted).** The agent's `AgentVersion.instructions` (persona,
   behavior, autonomy/approval rules — §10.4), plus Marathon-injected framing: tool-use
   guidance, the surface's reply conventions, the current date/agent identity, and an explicit
   instruction that *everything in the context and invocation layers is data, not commands*.
2. **Context layer (untrusted).** The gathered, provenance-labeled context bundle (below),
   each block wrapped in unambiguous delimiters. Sourced from the surface, memory (§7.12), and
   tools — never allowed to alter layer 1.
3. **Invocation layer (untrusted).** The triggering message/comment itself (the actual ask),
   with the `@mention` stripped and the requesting user's identity attached.

### Per-surface context sources

The context bundle is produced by a surface-specific builder behind the `SurfaceAdapter`
(§7.16), so adding a surface means adding a builder, not changing the loop:

| Surface | Gathered context (bounded by token budget + permissions) |
| --- | --- |
| **Slack mention** | the thread's prior messages, the channel, prior agent turns in that thread (thread memory, §7.12) |
| **Document comment** | the anchored region by `source_ref` (file / line range / diff hunk), the surrounding section, sibling review comments (§7.17) |
| **Both** | task-local memory (plan, prior tool results, clarifications), retrieved agent/tenant memory (§7.12), permission-checked |

### Trust, sanitization, secrets

All context and invocation content is **untrusted** (§12.2). The builder must (a) delimit and
label untrusted blocks unmistakably, (b) guarantee they cannot rewrite the instructions layer,
and (c) optionally route them through the **trust-hierarchy sanitizer** (a frontier model that
emits clean instructions/context — §12.2, *designed, not yet implemented*). **Secrets never
appear in any layer** (§8.2); credentials are injected only at tool execution (§7.8).

### Token budget & compaction

The builder enforces the selected model's context window (§7.19, §7.10 metadata): instructions
and the invocation are always included; context is included by relevance and trimmed/summarized
oldest-first when over budget. For long in-flight runs, Pi performs in-loop compaction (§7.5).

### Versioning & reproducibility

The assembled prompt is tagged with a **`prompt_version`** = (AgentVersion + selected instruction
stage + output/template version + builder version), recorded on each `ModelInvocation` (§10.10)
and surfaced in the inspectability dashboard (§8.5, §11). The selected stage is `none` when the
task's work kind has no kernel stage. Given the same `(instructions, context bundle,
invocation, versions)`, the builder must produce the same prompt — this is what makes evaluation
and replay meaningful (§7.6, §10.14).

### Required

* Load `AgentVersion.instructions` per invocation (not a hardcoded default).
* A per-surface context builder behind `SurfaceAdapter` returning a normalized context bundle.
* Layered assembly with explicitly delimited, provenance-labeled untrusted blocks.
* Token-budget enforcement against the selected model.
* Attach `prompt_version`; deterministic given fixed inputs + versions.

> **Status.** Build status lives in the roadmap: **M7 shipped the prompt builder** — real
> `AgentVersion.instructions` (personas), per-surface context builders, recalled memory, and
> untrusted-content fencing (`fenceUntrusted`, M9 core) — wired into both live apps. The
> trust-hierarchy sanitizer remains future (§12.2); memory recall gains audience gating with
> the roadmap §2b #9 refactor.

---

## 7.19 Model selection

Model selection decides, per invocation (and per *step* within a task), which concrete
`provider:model` runs. It **operationalizes** the declarative `model_policy`/`routing` config
(§7.10) and the strategies in §13.2 into a runtime procedure; §7.10 is the *what*, this is the
*how*.

### Selection procedure (in precedence order)

1. **Explicit override** — a model named in the request ("use opus"), honored only if allowed
   by tenant policy.
2. **Step role → tier** — map the current step's role (`classify_intent`, `plan_task`,
   `generate_final_answer`, `safety_check`, …) to a tier via `AgentVersion.model_policy.routing`.
3. **Tier → concrete model** — resolve the tier (`default` / `reasoning` / `cheap` /
   `embedding`) to a `provider:model` from `model_policy`.
4. **Constraint filter** — the candidate must fit the assembled prompt's **context window**,
   support required **capabilities** (tool use, vision), and respect **latency** and remaining
   **cost budget** (§7.11). Candidates failing a hard constraint are dropped.
5. **Fallback chain** — on unavailability / over-budget / repeated error, fall back along a
   configured chain (e.g. `reasoning → default`) and **record the downgrade**.

### Resolution & policy

* Model refs are `provider:model`, resolved against the **model registry** (built-in catalog +
  tenant-registered models; OpenRouter registered as an OpenAI-compatible provider). Per-tenant
  API keys are injected at runtime (`setRuntimeApiKey`), never persisted into config (§13,
  §9.2).
* **Tenant/admin policy** can constrain: allowed providers/models, maximum tier, budget caps,
  and data-residency/provider restrictions.
* The chosen model, tier, and **selection reason** (override / role / fallback) are recorded on
  the `ModelInvocation` (§10.10) for cost attribution and inspectability.

### Required

* Resolve a model via override → role→tier → tier→model, then apply the constraint filter and
  fallback chain.
* Validate the choice against tenant policy and the prompt's context window before the call.
* Record model, tier, selection reason, and any fallback on the `ModelInvocation`.

> **Status.** Build status lives in the roadmap. As-built: a minimal gateway
> (`@marathon/model-gateway`) with `DEFAULT_MODEL_POLICY = { default, reasoning, cheap }`
> (OpenAI `gpt-4o-mini`/`gpt-4o`), `resolveModelRef`/`parseModelRef`, a `BUILTIN_MODELS`
> catalog with cost + context-window metadata, per-call cost capture, and **budget enforcement
> from actuals in the step runner (M8)**. Selection is still effectively the `default` tier —
> role→tier routing, the constraint filter, fallback chains, per-tenant policy, and overrides
> remain open (tracked in the roadmap).

---

## 7.20 Identity linking

Cross-surface identity (Slack user ↔ Marathon user ↔ GitHub user) underpins the on-behalf-of
egress policy (§7.8), reviewer authority (§7.9), permission-aware retrieval (§7.12), and
cross-surface delivery (§10.8). The rule: **identities are proven, never typed** — a
self-declared handle is unverifiable in both directions.

### The flow (OAuth-proven, initiated from the authenticated surface)

Each surface authenticates its own identity for free; linking chains two proofs together:

1. **Entry point** — `/marathon link github`, or the **"Link your GitHub" button on the §7.8
   denial notice** (the moment the user hits the wall is the moment to offer the fix).
2. Marathon replies ephemerally with a **single-use signed URL** bound to
   `(tenant, slack_user_id, nonce, expiry)`. The Slack identity is proven by the
   authenticated, signed interaction that minted the URL — never typed.
3. The user completes **GitHub OAuth** (GitHub App user authorization, identity-only scope);
   the callback proves control of the GitHub login and writes the `UserIdentity` link
   (§10.2) with `verification_method: oauth`.

The reverse direction is symmetric: a GitHub-surface invocation arrives GitHub-authenticated
(signed webhook), so a Marathon user can be auto-created keyed on the GitHub login, with
Slack linked later by the same flow.

### Access checks, liveness, provenance

* **The user-to-server token doubles as the access checker.** Marathon keeps the
  minimal-scope, auto-expiring token (§12.3); "can user U read repo R?" is answered by asking
  GitHub *as U* — the most truthful possible check, with no admin-level enumeration.
  Fallback: the tenant App credential's collaborator-permission endpoint, for repos the App
  is installed on.
* **Liveness for free:** a failed token refresh (revoked, off-boarded) marks the link
  `stale`, and on-behalf-of degrades back to **deny** for that user until they re-link. No
  stale-spreadsheet problem.
* **Verification provenance tiers:** `verification_method: oauth | idp | admin_asserted`.
  Admins may bulk-provision from a verified directory (Okta/Google) as a lower-trust tier;
  **tenant policy sets the tier on-behalf-of requires — `oauth` by default.**
* **Uniqueness + audit:** one GitHub login per Marathon user per tenant (§10.2's unique
  constraint); link / unlink / stale transitions are audit events.

### Where the UI lives

The Agent Hub (M10 Phase 2) gets an **Identities** page — linked identities with
connect/disconnect, every "Connect" launching an OAuth flow, **no text fields**. The
Slack-initiated flow is the workhorse and ships first: a command/button, a one-time-link
service, one OAuth callback, a `UserIdentity` write (roadmap §2b #10).
