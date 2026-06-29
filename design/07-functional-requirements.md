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

The backend still models agents as named aliases, so a future move to per-agent `@mentions` remains possible, but it is not a goal now.

---

## 7.2 Agent registry

Marathon needs a registry of available agents.

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

**Default agent selection.** When a user invokes `@marathon` without naming an agent, Marathon should auto-select an agent based on the task type and the agents' declared capabilities, and tell the user which agent it chose.

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
blocked
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

Agent steps run inside an **agent harness**. The initial harness is **Pi**
(`@earendil-works/pi-coding-agent`), embedded **in-process** in the worker via its SDK. The
harness owns the in-task agent loop — prompting, tool calling, step sequencing, progress
emission, and per-call logging, retries, and redaction. See `pi-details.md` for the full
integration reference.

Requirements:

* Start with the **Pi harness** via its in-process SDK; keep it pluggable behind a thin
  interface. (RPC mode is the out-of-process fallback; the read-only JSON event mode cannot
  gate tools.)
* The harness runs *inside* the durable Agent Worker. Marathon owns durability around it
  (queueing, leases, checkpoints, resumption, idempotency); Pi owns the agent loop.
* **Permissioning is embedded in the harness.** *As-built:* Marathon registers each tool as a
  Pi **custom tool that delegates to the `ToolGateway`** (the gateway is the chokepoint —
  policy, credential injection, audit, redaction); destructive calls return an
  approval-required signal. Pi's **built-in** tools (`read/grep/find/ls`) bypass the gateway, so
  they are now **off by default** (`PiAgentRuntime.builtinTools`, default none) and enabled only
  inside a sandboxed workspace (§12.6); the `tool_call` hook remains the path to fully govern
  them when running Pi-in-sandbox (see §7.8, §12.6, `pi-details.md` §3 As-built).
* **The Pi session (a JSONL tree) is the durable agent checkpoint and the full trace.**
  Persist it per task; it powers crash-resume, the inspectability dashboard, and replay
  (see §11, §16).
* Pi provides model-call **logging, retries, and redaction**, plus per-model **cost metadata**,
  which keeps Marathon's Model Gateway minimal (see §9.2, §13). *As-built:* per-call cost is
  read from the turn's assistant message (`usage.cost.total`); budget enforcement is deferred
  to M8.
* **Pi has no built-in sandbox** — Marathon must run the harness and its tools under
  OS-level isolation (see §12.6).

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

Feedback is **incorporated into the agent's memory and future context** (§7.12) so an agent stops repeating a corrected mistake, and it can be promoted by the team into eval cases (§17).

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

Tools run **through the Pi harness**, which exposes a single tool interface to the agent loop; tool and connector definitions conform to it. **Permissioning is embedded in the harness** — Marathon supplies the policy and credentials, and Pi enforces them on every call (see §7.8). **Command-line tools are a first-class, primary tool type** alongside built-in connectors and MCP servers (see §14.5).

---

## 7.8 Tool permissioning

Tools are executed through the Pi harness, and **permissioning is embedded in the harness**: Marathon owns *what* is enforced — it **defines the policy, injects credentials, orchestrates approvals (durable waits + in-place prompts), and records the audit log** — at an in-loop chokepoint the model can neither bypass nor rewrite. *As-built (M6.1):* the chokepoint is the **`ToolGateway`**, reached by registering each Marathon tool as a Pi **custom tool whose `execute` delegates to `gateway.run`** (validate → policy → credential injection → execute → redact → audit). The originally-planned `tool_call`/`tool_result` hook (see `pi-details.md` §3) is equivalent and additionally covers Pi's **built-in** tools — which the custom-tool approach does not govern yet, and which therefore also depend on the sandbox work (§12.6). Two practical constraints learned in build: model-facing tool names must match `^[A-Za-z0-9_-]+$` (no dots — sanitized + mapped back), and only Marathon-registered tools currently flow through the gateway. Each tool should declare:

* Name
* Description
* Input schema
* Output schema
* Risk level
* Required credentials
* Required scopes
* Approval requirement
* Rate limits
* Timeout
* Retry policy
* Logging policy
* Redaction policy

Tool risk levels:

```text
low: read-only, low sensitivity
medium: non-destructive write, easily reversible (e.g. open a PR, post a comment)
high: destructive / irreversible / externally-visible (merge, delete, deploy, send email, rotate secret, modify data)
critical: production mutation, secret access, other high-blast-radius irreversible actions
```

Default policy (approval is gated on *destructiveness*, not on read-vs-write):

| Risk level | Default behavior                                  |
| ---------- | ------------------------------------------------- |
| Low        | Allowed if agent has permission                   |
| Medium     | Allowed — non-destructive writes run autonomously |
| High       | Requires human approval (destructive)             |
| Critical   | Disabled unless explicitly enabled by admin       |

---

## 7.9 Human approval

**Approval is for destructive/irreversible actions only.** Additive, reversible actions —
posting a comment, opening an issue, opening a pull request with a small edit, editing a
document (undoable via a PR) — are **not** destructive and run **autonomously** (no approval).
Approval is reserved for things like deploys, deletes, data changes, merge-to-protected, and
force-push. This is enforced by each tool's `destructive` flag (§7.8), not by a risk score.

Approvals are resolved through one of two **channels** (M10), both backed by the same durable
`ApprovalRequest`:

* **In-line** — an Approve/Reject prompt in the originating surface (e.g. Slack), for fast
  resolution where the work was requested; carries a link to the hub for full context.
* **Agent Hub (web UI)** — a queue of outstanding approvals with full context (the §16.3
  task timeline, proposed diff, cost, risk) and edit-then-approve; required for the highest-
  risk actions and for operators managing many agents.

Approval requests should include:

* Agent
* Task
* User
* Tool
* Proposed action
* Target system
* Input summary
* Risk level
* Expiration
* Approve button
* Reject button
* Edit option where possible

Approvals should be logged as audit events.

Approvals should support scopes:

```text
this_action_only
this_task_only
this_thread_only
this_channel_for_24h
always_for_this_agent_and_tool
```

For the MVP, support only `this_action_only`.

---

## 7.10 Model routing

Model routing should be declarative. This section defines the **policy**; §7.19 defines the
runtime **selection procedure** that applies it per invocation/step.

Example:

```yaml
model_policy:
  default: openai:gpt-4.1-mini
  reasoning: anthropic:claude-sonnet
  cheap: openai:gpt-4.1-nano
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
* Require approval above threshold

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

### Dimensions: scope × term

Memory is organized along two axes.

**Scope** (who owns it) — nested under a tenant, with agent and project orthogonal (an agent
works across projects; a project is worked on by many agents):

| Scope | Holds |
| --- | --- |
| **Tenant** | org-wide knowledge, conventions, policies (shared across all agents/projects) |
| **Project** | facts/decisions about one project (a **GitHub repo** for now; see below) |
| **Agent** | a named agent's learned preferences, runbooks, and corrections |
| **Thread** | working memory for one conversation (a Slack thread or document thread) |

**Term** (how long it lives):

* **Short-term** — working memory (recent thread turns), TTL'd; ranked by recency.
* **Long-term** — durable knowledge (summaries, corrections, facts); ranked by relevance.

> **Task-local memory is not in the store.** A single task's working state (plan, tool
> results, intermediate summaries) is already the durable **Pi session + checkpoint** (§7.5,
> §11.2). The memory store's short-term tier is **thread-level** (spanning the tasks in one
> conversation), so we don't duplicate the durable spine.

A recall for one invocation **unions all applicable scopes** (tenant + project + agent +
thread) and **both terms**, then ranks the merged set (relevance blended with recency) within
a token budget. Callers ask "what's relevant here?" — they do **not** pick a term.

### Project = GitHub repo (for now)

"Project" is a tenant-scoped grouping resolved from the invocation source. Initially a
**GitHub repo** (`owner/name`); a Slack channel or an explicit/generated `Project` can replace
it later via a pluggable **project resolver**, with no change to the store interface. Project
memory inherits the **repo-permission check** (§7.17): only agents/users with access to the
repo may read or write its memory.

### The store is swappable — `MemoryStore`

Marathon does not hard-code a memory engine. All memory flows through a `MemoryStore`
interface; backends are adapters. This lets us start simple and graduate to a purpose-built
memory layer without touching the rest of the system.

```ts
type MemoryTerm = "short" | "long";
type MemoryLevel = "tenant" | "project" | "agent" | "thread";
interface MemoryScope { tenantId: string; projectId?: string; agentId?: string; threadId?: string; }

interface MemoryItem {
  id: string; scope: MemoryScope; level: MemoryLevel; term: MemoryTerm;  // term set on write
  kind: string;           // summary | correction | preference | message | fact | ...
  text: string; metadata?: Record<string, unknown>;
  source?: { taskId?: string }; createdAt: Date; expiresAt?: Date;       // short-term TTL
}

interface MemoryStore {
  remember(item): Promise<MemoryItem>;
  recall(q: { query: string; scope: MemoryScope; levels?: MemoryLevel[];   // default: all applicable
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

* **Long-term** ← the task **result summaries** Marathon already produces, plus **feedback
  corrections** (a 👎 + correction becomes an agent-scoped `correction` item) — this is the
  "feedback incorporated into future context" goal (§7.6).
* **Short-term** ← **thread turns**, written with a TTL.
* **Recall** is called by the prompt builder (§7.18) on each invocation.

### Requirements (now enforced by the store)

* **Tenant-isolated**; project memory gated by repo permission (§7.17).
* **Inspectable** (`list`) and **deletable** (`forget`) per scope — for the dashboard (§16)
  and retention/erasure (§12.5).
* Configurable **retention**; short-term **TTL**; **redaction** of sensitive content (§12.2).
* **Optional by default** — an agent uses memory only if configured to.

> **As-built status.** Not implemented yet (M7). Today the agent runs with no memory recall or
> persistence beyond the per-task checkpoint, and the prompt builder (§7.18) does not yet
> inject recalled memory.

---

## 7.13 Admin console

> Initial scope: internal. The admin console is operated by the Marathon team for now, not exposed to customers — except the **inspectability dashboard** (§5.5), which users and admins do see. Documented here for direction.

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

> Initial scope: internal only — there is **no external-facing agent SDK**. Agents are built by the Marathon team. The sketch below describes the internal authoring model, kept for direction.

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
    Use evidence. Be concise. Ask for approval only before destructive actions.
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

* Agents create and update markdown documents via `document.*` tools (see §14.6), under the Pi harness tool layer and approval model. On GitHub this means committing to a branch and opening a pull request.
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

The assembled prompt is tagged with a **`prompt_version`** = (AgentVersion + output/template
version + builder version), recorded on each `ModelInvocation` (§10.10) and surfaced in the
inspectability dashboard (§8.5, §11). Given the same `(instructions, context bundle,
invocation, versions)`, the builder must produce the same prompt — this is what makes
evaluation and replay meaningful (§7.6, §10.14).

### Required

* Load `AgentVersion.instructions` per invocation (not a hardcoded default).
* A per-surface context builder behind `SurfaceAdapter` returning a normalized context bundle.
* Layered assembly with explicitly delimited, provenance-labeled untrusted blocks.
* Token-budget enforcement against the selected model.
* Attach `prompt_version`; deterministic given fixed inputs + versions.

> **As-built status (MVP).** The builder is minimal: a **generic hardcoded instruction string**
> (e.g. "You are Marathon, a concise engineering assistant.") plus the **raw mention text** as
> the user message. `AgentVersion.instructions` is **not loaded**, and there is **no thread or
> document context, no memory, and no sanitization** assembled into the prompt (Pi's built-in
> read/grep tools can still pull file context mid-run). Closing this — load real instructions +
> a surface context builder + untrusted-content delimiting — is tracked in roadmap §2b / M7.

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

> **As-built status (MVP).** A minimal model gateway exists (`@marathon/model-gateway`):
> `DEFAULT_MODEL_POLICY = { default, reasoning, cheap }` (default **OpenAI**
> `gpt-4o-mini`/`gpt-4o`, since that's where credits are), `resolveModelRef`/`parseModelRef`,
> and a `BUILTIN_MODELS` catalog with cost + context-window metadata; cost is computed per call.
> But **selection is effectively always the `default` tier** — the live apps pass a fixed
> `modelRef` — so **role→tier routing, the constraint/budget filter, fallback chains, per-tenant
> policy, and overrides are not implemented yet** (budget *enforcement* is M8; the rest folds
> into M7/M8).
