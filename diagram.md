# Marathon Architecture Diagram — Spec

This document describes **what an architecture diagram for Marathon should show**. It
is a brief for whoever draws the diagram (in Excalidraw, Mermaid, diagrams.net, etc.),
not the diagram itself. It is derived from `design.md` §9 (reference architecture) and
the decisions integrated since.

There should be **one primary component diagram** plus a few **sequence diagrams** for
the key flows. Each is specified below.

---

## 1. What the diagram must convey

If a viewer takes away only a few things, they should be these. The drawing should make
them visually obvious:

1. **Marathon is surface-shaped.** Slack and GitHub-backed markdown documents are *both*
   first-class entry points, behind a common surface abstraction. The core engine knows
   nothing about any specific surface.
2. **The durable task is the spine.** Every invocation becomes a persisted, checkpointed
   task in Postgres; workers are replaceable and stateless except for leased work.
3. **The agent loop runs inside the Pi harness** (`@earendil-works/pi-coding-agent`,
   embedded in-process via its SDK), which itself runs inside Marathon's durable Agent
   Worker. Marathon owns durability *around* Pi; Pi owns the loop. The **Pi session JSONL
   is the durable checkpoint and full trace** (powers crash-resume, inspectability, replay).
4. **The model layer is minimal.** Marathon routes and reads **cost from Pi** (model cost
   metadata + session stats); providers (Claude, ChatGPT) and OpenRouter — plus Pi — do the
   heavy lifting (budgets, logging, retries, redaction). Per-tenant keys are injected at
   runtime (`setRuntimeApiKey`).
5. **Tools run through the Pi harness, and the harness's tool layer is the single
   chokepoint** for all side effects. Agents never reach external systems directly.
   Permissioning is *embedded in the harness* via Pi's `tool_call` hook (block/mutate +
   inject credentials) and `tool_result` hook (redact/log); Marathon supplies the policy
   and owns approval and audit.
6. **Approval is for destructive actions only**, requested *in place* on the originating
   surface (Slack thread / PR comment), implemented as **block-persist-resume** (Pi has no
   native multi-day suspend).
7. **Pi has no built-in sandbox** — Marathon adds OS-level isolation and routes tool
   execution (esp. `bash`/writes) through a sandbox (container/VM + Gondolin / OpenShell).
7. **Trust boundaries are explicit.** Surface content, tool output, and model output are
   untrusted; secrets never reach the model; policy is enforced outside the model.

---

## 2. Primary diagram: component / data-flow view

### 2.1 Zones (draw as labeled bands or containers)

Group nodes into these zones so the layering reads top-to-bottom:

- **Surfaces (external)** — where users are.
- **Ingress** — surface gateways + invocation routing.
- **Core (durable)** — orchestrator, Postgres, queue.
- **Execution** — agent workers running the Pi harness.
- **Harness exits** — the minimal model gateway, and the tool layer *embedded in the Pi
  harness* (the two controlled exits from the agent loop).
- **External systems** — model providers and connector targets.
- **Control plane** — registries, audit, inspectability, admin/config.

### 2.2 Nodes to show

**Surfaces (external)**
- Slack
- GitHub (markdown docs: files, PRs, issues, review/PR comments)
- *(greyed-out / "later":* Web console, Email, Scheduler, other doc providers like Google Docs/Notion *)*

**Ingress**
- **Surface Gateways** — one per surface (Slack gateway, GitHub/document gateway). Show
  them as instances of a shared interface. Responsibilities to annotate: verify
  authenticity (Slack signature / webhook secret / OAuth), deduplicate events,
  acknowledge fast, normalize to a common invocation shape, enqueue.
- **Invocation Router** — resolves the agent (named, or **default agent** when none is
  named), checks tenant/channel-or-repo/user permissions, creates the task, attaches
  surface-native context, sends the quick acknowledgement.

**Core (durable)**
- **Task Orchestrator** — task lifecycle, step scheduling, checkpoints, retries, durable
  human waits, dead-letter. Label it "the heart of Marathon."
- **Postgres** — tasks, steps, checkpoints, model/tool invocations, approvals, feedback,
  audit, registries, document artifacts. (Also the queue substrate — see below.)
- **Task Queue** — drawn as **Postgres-backed** (not a separate broker) for the MVP; note
  it is kept workflow-engine-compatible (Temporal swappable later).

**Execution**
- **Agent Worker** — durable wrapper (leases, heartbeats, checkpoint/resume). Show the
  **Pi harness (`@earendil-works/pi-coding-agent`, in-process SDK) running *inside* the
  worker** as a nested box. Annotate Pi's ownership: the agent loop — prompting, tool
  calling, step sequencing, progress, per-call logging / retries / redaction. Note the
  **per-task Pi session JSONL** is the durable checkpoint + trace. Pi has **no sandbox** —
  the worker+Pi run under OS-level isolation (see below).

**Harness exits (the two controlled exits from the agent loop, both via Pi)**
- **Model Gateway (minimal)** — model calls run through Pi; the gateway does routing +
  **cost read from Pi** (model cost metadata + session stats) and passes budget enforcement
  through to providers/OpenRouter. Per-tenant keys injected at runtime (`setRuntimeApiKey`).
  Logging/retries/redaction come from Pi and provider SDKs, not reimplemented here.
- **Tool layer (embedded in Pi)** — the chokepoint for side effects; draw it *inside* the
  Pi box, not as a separate service. It is wired through Pi's **`tool_call` hook**
  (block/mutate + inject credentials) and **`tool_result` hook** (redact/log). Annotate what
  Pi enforces per call: permission check, input-schema validation, **destructive-action
  approval check**, rate limits, execution with Marathon-injected credentials, output
  redaction, structured result. Annotate what Marathon owns *around* it: the policy/grants,
  credentials, approval orchestration, and audit. Add the rule "the agent loop cannot bypass
  the harness tool layer, and the model cannot rewrite its policy."

**External systems**
- **Model providers**: Anthropic (Claude), OpenAI (ChatGPT), **OpenRouter**.
- **Connectors / tool sources** behind the harness tool layer — show the three tool *kinds*
  distinctly:
  - Built-in connectors (GitHub, Slack, Postgres/DB, Datadog, …)
  - **Command-line tools** (primary tool type; some supplied by Pi)
  - **MCP servers** (customer-provided tools)
- **Memory / Retrieval service** — task / thread / agent memory + tenant knowledge,
  permission-filtered. Show feedback feeding agent memory.

**Control plane**
- **Agent Registry** and **Connector/Tool Registry**
- **Audit Log** (security-relevant events)
- **Inspectability dashboard** (per-task timeline: model calls, tool calls, data seen,
  cost, failures, prompt/model versions) — the one user/admin-facing view
- **Admin/config** (internal for now) — secrets store, budgets/policies, model provider
  config

**Surface Delivery**
- **Surface Delivery Service** — renders the structured result back to the *originating*
  surface (Slack threaded message / GitHub comment or PR). Note delivery target may differ
  from the source.

### 2.3 Edges / flows to draw

Show direction on every edge. The main request path:

```
Slack / GitHub  →  Surface Gateway  →  Invocation Router  →  Task Orchestrator
Task Orchestrator ↔ Postgres            (persist task, checkpoints)
Task Orchestrator → Task Queue → Agent Worker (Pi harness)
Agent Worker → Pi harness → Model Gateway (minimal) → {Claude | ChatGPT | OpenRouter}
Agent Worker → Pi harness (tool layer, embedded permissioning) → {built-in connectors | CLI tools | MCP servers} → external systems
Agent Worker ↔ Memory/Retrieval
Agent Worker → Surface Delivery Service → originating surface (progress + final result)
```

Cross-cutting edges (draw lighter, or they'll clutter):

- Every model call and tool call **writes to Postgres** (model/tool invocation records)
  and **emits audit events**.
- **Inspectability dashboard** and **Admin/config** read from Postgres / Audit Log.
- **Credential injection**: the secret store injects credentials into Pi's tool layer at
  execution time (never into the model prompt path).
- **Approval loop (block-persist-resume)**: Pi's `tool_call` hook **blocks** a destructive
  call → Marathon persists the Pi session JSONL and tears down the worker → Orchestrator
  marks the task `waiting_for_approval` → Surface Delivery posts the prompt in place → human
  approves → Orchestrator **re-opens the Pi session and re-enters** so the action runs. Draw
  this as a distinct, labeled loop because it's a key behavior.
- **Feedback loop**: surface 👍/👎 → Surface Gateway → Postgres → Memory/Retrieval (agent
  memory) and the eval/feedback store.

### 2.4 Trust boundaries (draw as dashed enclosures / colored borders)

- A boundary around **external/untrusted input**: Slack content, document body & comments,
  and **tool output** are all untrusted. Annotate "treated as data, never as instructions."
- A boundary marking **"secrets never cross into the model."** Show secrets living in the
  secret store and injected only into the harness tool layer / connectors at execution time,
  never into the model prompt path.
- A boundary showing **policy enforced outside the model** — permission and approval checks
  sit in the harness's *tool layer* (configured by Marathon) and the orchestrator; the model
  proposes calls but cannot approve, bypass, or rewrite the policy.
- The **agent trust hierarchy** (optional callout): a frontier model sanitizes untrusted
  content into clean context that smaller execution-focused models consume.
- **Tenant isolation**: indicate that tasks, data, secrets, and registries are scoped per
  tenant.

---

## 3. Suggested layout (reference sketch)

This is the intended shape, not the final art:

```
            ┌─────────────────────────────────────────────────────────┐
 SURFACES   │   Slack            GitHub (markdown docs / PRs / comments) │   [later: Web, Email, Scheduler]
            └─────────┬───────────────────────┬─────────────────────────┘
                      │                        │
 INGRESS         Slack Gateway          Document Gateway        ← shared Surface interface
                      └───────────┬────────────┘
                            Invocation Router  (resolve agent / default agent, authz, create task, ack)
                                   │
 CORE                       Task Orchestrator ───────────────  Postgres  (tasks, steps,
 (durable)                         │                            checkpoints, invocations,
                              Task Queue (Postgres-backed)      approvals, feedback, audit)
                                   │
 EXECUTION                  ┌────────────────────────────────────┐
                            │  Agent Worker (durable: leases,     │
                            │  checkpoint/resume)                 │
                            │  ┌──────────────────────────────┐   │
                            │  │  Pi harness (in-process SDK)  │   │
                            │  │  agent loop · model calls ·   │   │
                            │  │  TOOL LAYER (tool_call hook)  │   │
                            │  │  session JSONL = checkpoint   │   │
                            │  └──┬────────────────────────┬──┘   │
                            └─────┼────────────────────────┼──────┘
                          model calls │            tool calls │ (policy enforced here)
 EXITS         Model Gateway (min: route + cost)             │
                        │                                     │
 EXTERNAL      Claude / ChatGPT / OpenRouter         Built-in connectors | CLI tools | MCP servers
                                                     (GitHub, DB, Datadog, …) → external systems

               Marathon owns AROUND the tool layer: policy/grants · credentials · approval · audit
               Pi has NO sandbox → worker+Pi run isolated (container/VM + Gondolin / OpenShell)
                                   Memory / Retrieval  ←→  Agent Worker

 DELIVERY      Surface Delivery Service  →  back to the originating surface (progress + result)

 CONTROL       Agent/Tool Registries · Audit Log · Inspectability dashboard · Admin/config (internal)

 — — — trust boundaries: untrusted surface/tool/model content · secrets never reach the model · tenant isolation
```

---

## 4. Companion sequence diagrams

Three flows are worth their own simple swimlane/sequence diagrams. They explain behavior
the component diagram can't.

### 4.1 Slack investigation (read-only, autonomous)
`User → Slack → Slack Gateway → Invocation Router → Orchestrator (task created, ack) →
Worker/Pi (tool layer → read tools: GitHub, Datadog; model calls via the minimal gateway)
→ Surface Delivery → Slack thread (progress + final result) → 👍/👎`. Emphasize: no approval
(non-destructive), durable checkpoints between steps, automatic retry on a transient tool failure.

### 4.2 Document-driven execution (the headline flow)
`Slack request → agent drafts a design doc as a markdown PR → people comment on the PR →
agent revises → human merges the PR (merge = approval) → agent executes the approved plan,
posting progress to both the PR and the Slack thread`. Emphasize: the document is the
durable plan of record; approval-by-merge; cross-surface (source = Slack, artifact = GitHub).

### 4.3 Destructive action with approval (block-persist-resume)
`Pi's tool_call hook blocks a destructive call → Marathon persists the Pi session JSONL and
tears down the worker → Orchestrator sets task waiting_for_approval (durable wait, may last
days) → approval prompt posted in place on the surface → human approves → Orchestrator
re-opens the Pi session and re-enters → the action executes (with injected credentials) →
audit event → result delivered`. Emphasize: enforcement happens in the harness, **no process
held during the wait**, in-place approval, idempotency key so a retry/duplicate event can't
double-execute.

---

## 5. Annotations and call-outs to include

- Mark **kernel scope (design §0)** vs **later** (grey out web/email/scheduler, extra doc
  providers, multi-tenant/SSO, in-app approvals).
- Note **idempotency** on the write edges (e.g. `repo + path + base_sha` for doc edits;
  `surface_type + external_event_id` for incoming events).
- Note **cost tracking** point at the Model Gateway — cost is **read from Pi** (model cost
  metadata + session stats) and is **silent by default** (surfaced on completion).
- Label the Pi box clearly so it's obvious Pi is the agent runtime (`@earendil-works/pi-coding-agent`,
  in-process SDK), swappable behind a thin interface, with the **session JSONL** as the
  durable checkpoint/trace.
- Show the **`tool_call` / `tool_result` hooks** as the embedded-permissioning mechanism.
- Show that **Pi has no sandbox** → the worker+Pi run isolated (container/VM + Gondolin /
  OpenShell). See `pi-details.md`.

## 6. What to leave out

- Don't draw a separate model "router brain," fancy multi-broker queue, or a vector-DB
  cluster — the MVP is Postgres (+ pgvector) and a minimal model layer; over-drawing them
  misrepresents the intended simplicity.
- Don't draw a separate **Tool Gateway service** — tool permissioning is *embedded in the
  Pi harness* (the tool layer); show Marathon owning the policy/credentials/approval/audit
  *around* it, not a standalone box in the request path.
- Don't show per-agent Slack bot identities — it's a single `@marathon` bot.
- Don't depict user-initiated cancellation — deferred.
- Keep cross-cutting edges (audit/cost/persistence) visually subordinate so the primary
  request path stays legible.
```
