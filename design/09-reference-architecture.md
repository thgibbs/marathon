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
  +--> Pi harness  (agent loop + tool layer with embedded permissioning)
  |       |
  |       +--> Model access --> Model Gateway (minimal) --> Claude / ChatGPT / OpenRouter
  |       |
  |       +--> Tool layer (permissioning) --> GitHub / Database / Datadog / Docs connectors,
  |       |                                    command-line tools, MCP servers
  |       |       (credentials injected by Marathon; never exposed to the model)
  |       |
  |       +--> destructive action --> Task Orchestrator: durable approval wait
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

The Agent Worker runs the **Pi harness** (§7.5), embedded in-process via its SDK: Marathon provides the durable wrapper (leasing, checkpointing, resumption) and Pi runs the agent loop inside it. The per-task **Pi session JSONL** is persisted as the durable checkpoint and trace.

Responsibilities:

* Execute agent task steps
* Load context
* Run the agent loop in the Pi harness (model calls + tool calls)
* Enforce tool permissioning in the harness tool layer (policy/credentials from Marathon)
* Emit progress updates
* Save intermediate state
* Respect cancellation
* Request approval when needed

Workers should be stateless except for currently leased work.

**Execution isolation (target, §12.6).** The durable spine (worker/orchestrator/DB) and the
`ToolGateway` — which hold credentials — stay on the **host**. The **agent loop runs in a
sandbox** (Pi RPC mode) with a credential-free, egress-denied, ephemeral workspace; **code/FS
tools execute in the sandbox**, while **credentialed tools are brokered back to the host** gateway
(creds + policy + approval + redaction stay host-side). Today this is a seam (`ToolSandbox`,
default `NoSandbox` refuses); the Docker/microVM runtime is M9.

---

### Model Gateway (minimal)

Keep this thin. Providers (Anthropic, OpenAI) and **OpenRouter** can enforce budgets, and the **Pi harness** handles model-call logging, retries, and redaction — so Marathon's gateway should focus on what it uniquely needs: routing and **cost tracking**.

Responsibilities:

* Abstract the initial providers (Claude, ChatGPT, OpenRouter)
* Apply routing policies
* Track cost per call (for budgets and reporting) — **read from Pi per call** (the turn's
  assistant-message `usage.cost.total`) rather than re-metering. *As-built:* capture is done
  (a `ModelInvocation` row per turn); budget **enforcement** is deferred to M8.
* Inject **per-tenant API keys at runtime** (Pi `setRuntimeApiKey`), not from shared env/config
* Pass budget enforcement through to the provider / OpenRouter where possible

Logging, retries, fallbacks, redaction, and streaming come from Pi and the provider SDKs rather than being reimplemented here.

---

### Tool layer (embedded in the Pi harness)

Tools run **inside the Pi harness**, not through a separate gateway service. The harness is the single chokepoint for side effects, and **permissioning is embedded in it**. Marathon configures and audits this layer; Pi enforces it on every call.

Enforced in the harness (per tool call):

* Enforce tool permissions (policy supplied by Marathon)
* Validate tool input schema
* Detect when an action is destructive and requires approval
* Execute the connector / CLI / MCP call with Marathon-injected credentials
* Redact sensitive outputs
* Apply rate limits
* Return a structured result

Owned by Marathon (around the harness):

* The tool **policy** and tool grants — the model cannot change them
* **Credentials / secrets** — injected at execution, never exposed to the model
* **Approval orchestration** — durable waits and in-place prompts on the surface; a destructive call pauses the task and resumes when a human approves (see §11.6)
* **Audit logging** and **cost / usage records** in Postgres

The agent loop cannot bypass the harness tool layer, and the model cannot rewrite the policy it enforces.

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
adapters (**pgvector** default, **Mem0** as the first external backend).

Responsibilities:

* `remember` / `recall` / `forget` / `list` over **tenant / project / agent / thread** scopes,
  searching short- and long-term together
* Embed content (OpenAI `text-embedding-3-small` for the pgvector adapter)
* Enforce **tenant isolation** + **project (repo) permission** filters (§7.17)
* Rank recall by relevance blended with recency, within a token budget
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
