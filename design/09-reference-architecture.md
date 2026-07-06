# 9. Reference architecture

## 9.1 High-level architecture

```text
Surfaces (Slack, Documents, Web, API, ...)
  |
  v
Surface Gateways  (Slack gateway, Document gateway, ...)
  |
  v
Invocation Router
  |
  v
Task Orchestrator  <---->  Postgres
  |
  v
Task Queue
  |
  v
Agent Workers (durable wrapper)
  |
  +--> Agent harness: Pi (in-process) | Claude Code (headless, in-sandbox) — tools delegate to the ToolGateway
  |       |
  |       +--> Model access --> Model Gateway (minimal) --> Claude / ChatGPT / OpenRouter
  |       |
  |       +--> ToolGateway (host-side plumbing) --> GitHub / Database / Datadog / Docs connectors,
  |       |                                    command-line tools, MCP servers
  |       |       (credentials injected by Marathon; never exposed to the model)
  |       |
  |       +--> high-risk effect --> propose_effect --> durable review wait --> executor acts on approval
  |
  +--> Memory/Retrieval Service
  |
  v
Surface Delivery Service

Admin UI
  |
  v
Marathon API
  |
  +--> Agent Registry
  +--> Connector Registry
  +--> Task History
  +--> Eval System
  +--> Audit Log
```

---

## 9.2 Core services

### Surface Gateways

Each surface has a gateway (Slack gateway, Document gateway, …). Responsibilities:

* Receive surface events (Slack events, document comment notifications, web/API calls)
* Verify authenticity (Slack signature, OAuth, webhook secret)
* Deduplicate events
* Acknowledge quickly
* Normalize payloads into a common invocation shape
* Enqueue invocation events

Gateways should not run agents directly. Adding a surface means adding a gateway, not changing the core.

> *As-built transports:* **Slack** ingests via **Socket Mode** (a persistent WebSocket; no
> public URL — `apps.connections.open`, ack each envelope), so the HTTP signature path exists
> but isn't on the live path. **GitHub** ingests via **HTTP webhooks** (`X-Hub-Signature-256`
> verify + `X-GitHub-Delivery` dedupe). Result delivery is performed by the app layer
> (`@marathon/slack-app` / `@marathon/github-app`) after the worker completes, not by the
> worker itself.

---

### Invocation Router

Responsibilities:

* Parse the normalized invocation (from any surface)
* Resolve agent name
* Check tenant / channel-or-document / user permissions
* Create task
* Choose agent version
* Attach surface-native context (thread, document region)
* Send acknowledgement

---

### Task Orchestrator

Responsibilities:

* Manage task lifecycle
* Schedule steps
* Store checkpoints
* Handle retries
* Handle cancellations
* Handle waiting states
* Resume failed tasks
* Move terminal failures to dead-letter queue

This is the heart of Marathon.

---

### Agent Worker

The Agent Worker runs the **configured harness** behind the `AgentRuntime` seam (§7.5) — **Pi** embedded in-process, or **Claude Code headless** as a sandboxed subprocess (integration references: `pi-details.md`, `claude-code-impl.md`): Marathon provides the durable wrapper (leasing, checkpointing, resumption) and the harness runs the agent loop inside it. The per-task **harness session JSONL** is persisted as the durable checkpoint and trace.

Responsibilities:

* Execute agent task steps
* Load context
* Run the agent loop in the configured harness (model calls + tool calls)
* Route every governed tool call through the `ToolGateway` (credentials, read ledger, egress routing — §7.8)
* Emit progress updates
* Save intermediate state
* Respect cancellation
* Request approval when needed

Workers should be stateless except for currently leased work.

**Execution isolation (target, §12.6).** The durable spine (worker/orchestrator/DB) and the
`ToolGateway` — which hold credentials — stay on the **host**. The **agent loop runs in a
sandbox** (Pi RPC mode, or the Claude Code subprocess — Pattern 1, §12.6) with a
credential-free, egress-denied, ephemeral workspace; **code/FS
tools execute in the sandbox**, while **credentialed tools are brokered back to the host** gateway
(creds + policy + approval + redaction stay host-side). Under Claude Code the harness's own
model call is the one extra exit: a host-side key-injecting proxy on an internal-only
network (§12.6). Today this is a seam (`ToolSandbox`,
default `NoSandbox` refuses); the Docker/microVM runtime is M9.

---

### Model Gateway (minimal)

Keep this thin. Providers (Anthropic, OpenAI) and **OpenRouter** can enforce budgets, and the **Pi harness** handles model-call logging, retries, and redaction — so Marathon's gateway should focus on what it uniquely needs: routing and **cost tracking**.

Responsibilities:

* Abstract the initial providers (Claude, ChatGPT, OpenRouter)
* Apply routing policies
* Track cost per call (for budgets and reporting) — **read from Pi per call** (the turn's
  assistant-message `usage.cost.total`) rather than re-metering. *As-built:* capture is done
  (a `ModelInvocation` row per turn); budgets are enforced from actuals (M8).
* Inject **per-tenant API keys at runtime** (Pi `setRuntimeApiKey`), not from shared env/config
* Pass budget enforcement through to the provider / OpenRouter where possible

Logging, retries, fallbacks, redaction, and streaming come from Pi and the provider SDKs rather than being reimplemented here.

---

### ToolGateway (the host-side tool chokepoint)

Every governed tool executes in Marathon's **`ToolGateway`** — an in-process chokepoint, not a separate service. Pi runs the agent loop; each Marathon tool is a Pi custom tool whose `execute` delegates to the gateway. The gateway is **plumbing, not a policy brain** (`policy.md` §11.1): *what an agent may do* is enforced by credential scope, resource-native permissions, and the egress policy (§7.8); *which tools it has* is fixed at construction time (registration).

Per tool call, the gateway:

* Validates the input schema (and that the tool was registered for this task)
* Records reads in the task's **source-sensitivity ledger** (feeds the egress policy — §7.8)
* Routes egress per policy: autonomous / native review / `propose_effect` / **denied** (§7.8, §7.9)
* Selects and injects the **tenant's** credentials — never exposed to the model or the sandbox
* Executes the connector / CLI / MCP call; redacts sensitive output; applies rate/budget caps
* Writes the audit and cost/usage records (Postgres); honors the emergency kill switch

**Approval orchestration** stays at the task layer: a high-risk proposal is enqueued asynchronously, and on approval the non-model executor performs the exact approved artifact (§7.9, §11.6).

The agent loop cannot bypass the gateway, and the model cannot rewrite what it enforces.

---

### Connector Services

Responsibilities:

* Integrate with external systems
* Manage OAuth/API credentials
* Expose typed tools
* Normalize outputs
* Handle connector-specific retries
* Respect external rate limits

---

### Memory/Retrieval Service

Implements the swappable **`MemoryStore`** seam (§7.12): scope×term memory behind pluggable
adapters (**pgvector** default, **Mem0** as the first external backend). Holds **generated**
memory only — external documents are tool reads with their own ACLs (§7.12), never ingested.

Responsibilities:

* `remember` / `recall` / `forget` / `list` over **tenant / project / user / thread** scopes,
  searching short- and long-term together (agent is relevance metadata, not a scope)
* **Audience-gate recall** (task audience ⊆ scope audience — §7.12) and report recalled
  scopes to the egress policy as sources (§7.8)
* Enforce **write gating**: narrowest applicable scope; tenant-scoped writes require
  confirmation
* Embed content (OpenAI `text-embedding-3-small` for the pgvector adapter)
* Enforce **tenant isolation**; rank recall by relevance blended with recency (agent tags
  boost relevance), within a token budget
* Retain/expire per policy; redact sensitive content

---

### Feedback and Evaluation Service

Responsibilities:

* Capture feedback
* Convert feedback to review items
* Promote examples into eval cases
* Run regression tests
* Compare agent versions
* Report quality trends

---

### Admin API and UI

Responsibilities:

* Agent management
* Connector management
* Task inspection
* Cost reporting
* Security policies
* Audit logs
* Eval management
