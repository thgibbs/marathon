# Marathon Implementation Plan

This plan turns the architecture (`diagram.md` / `diagram.html`) and functionality
(`design.md`) into a concrete, build-ordered sequence. It is engineering-facing:
each milestone lists what to build, the data/contracts it touches, what it depends
on, and a demoable exit criterion.

**Build philosophy: spine first, then exits, then surfaces.** We build the durable
task engine before anything user-facing, integrate the Pi harness and the tool layer
next (the two controlled exits), then layer surfaces (Slack, then the GitHub document
surface) on top, then approval, the document-driven workflow, memory, and ops. Each
milestone is independently testable.

> Terminology: **Tenant** is the top-level isolation boundary. A Slack workspace and a
> GitHub installation are surfaces within a tenant.

---

## 0. Platform choices (fixed inputs)

These are decided in `design.md`; the plan assumes them.

| Area | Choice |
| --- | --- |
| Surfaces (MVP) | Slack **and** GitHub-backed markdown documents (both day-one) |
| Invocation | Single `@marathon` bot; agent named after it; **default agent** if none |
| Agent runtime | **Pi harness** (agent loop + tool calling + logging/retries/redaction), wrapped by a durable worker |
| Tool permissioning | **Embedded in Pi**; Marathon owns policy, credentials, approval, audit |
| Models | Claude, ChatGPT, OpenRouter (no local). **Minimal** model gateway: routing + cost only |
| Approval | **Destructive actions only**, requested in place on the surface; durable waits |
| Retries | Automatic for transient failures; never silent for destructive actions |
| Tasks | Durable, idempotent, checkpointed; Postgres + Postgres-backed queue |
| Feedback | 👍 / 👎 + optional text; fed into agent memory |
| Trace logging | Full, on by default; configurable by tenant / data class |
| Cancellation | **Not** in MVP |
| Stack | Fastify (API/gateways), TypeScript worker, Next.js (internal UI), Postgres (+pgvector), Docker Compose; OpenTelemetry |
| Admin / SDK / CLI | Internal-only for now (except the inspectability view) |

---

## 1. Critical interfaces to lock early

Get these contracts right before building broadly; everything hangs off them.

### 1.1 `SurfaceAdapter` (the seam that keeps the core surface-agnostic)
```ts
interface SurfaceAdapter {
  resolveIdentity(event): Promise<{ user: UserId; tenant: TenantId }>;
  parseInvocation(event): Promise<NormalizedInvocation>;   // agent name (or none) + text + anchor
  loadContext(ref: SourceRef): Promise<ContextBundle>;     // thread / file / diff hunk
  acknowledge(ref: SourceRef): Promise<void>;              // fast "started"
  postProgress(ref: SourceRef, msg): Promise<void>;
  requestApproval(ref: SourceRef, req): Promise<void>;     // render in place
  deliverResult(target: DeliveryTarget, result: StructuredResult): Promise<void>;
  captureFeedback(event): Promise<Feedback>;
}
```
`SourceRef` is opaque per surface (Slack: channel+thread_ts; GitHub: repo+path+line/comment id).
The core engine imports this interface, never Slack/GitHub SDKs directly.

### 1.2 Pi harness integration boundary (see `pi-details.md`)
Marathon embeds Pi (`@earendil-works/pi-coding-agent`) **in-process** via its SDK. Most of
this contract is now confirmed from the docs:
- **Tool interception / permissioning — confirmed.** Pi's `tool_call` hook can block or
  mutate each call (inject credentials), and `tool_result` can redact/log — the
  embedded-permissioning mechanism (§1.3, M3).
- **Models / cost — confirmed.** Providers via `getModel` / `registerProvider` (OpenRouter =
  OpenAI-compatible); per-tenant keys via `setRuntimeApiKey`; cost/tokens read from Pi's
  model cost metadata + session stats.
- **Durable approval wait — the one open question.** Pi has no native multi-day suspend, so
  we use **block-persist-resume** (block the call, persist the session JSONL, resume by
  re-opening it). Only the re-entry mechanism is open — see risk §6.1.

### 1.3 `ToolPolicy` (what Pi enforces, supplied by Marathon)
```ts
interface ToolGrant {
  tool: string; riskLevel: 'low'|'medium'|'high'|'critical';
  destructive: boolean; requiresApproval: boolean;
  constraints?: { repos?: string[]; readonly?: boolean; ... };
  credentialRef: string;          // resolved + injected at exec, never shown to model
  rateLimit?: RateLimit; redaction?: RedactionRule[];
}
```

### 1.4 Durable task records
`Task`, `TaskStep`, `ModelInvocation`, `ToolInvocation`, `ApprovalRequest` per
`design.md` §10. Source identity lives in `source_type` + `source_ref` (no Slack
columns in core tables).

---

## 2. Milestones

MVP = **M0–M6** (both surfaces, durable agent tasks, GitHub tools, destructive-only
approval, the document-driven workflow, basic feedback). M7–M9 round it out.

> **Status (build progress).** ✅ **Done & CI-green:** M0, M1, M2, M3, M4, M5, **M5.5**,
> M6, **M6.1**, **M6.2** — the MVP plus the live-integration follow-ons, each runtime-verified
> against real OpenAI / GitHub / Slack. ⏳ **Next:** M7 (memory). See **§2b** for items the
> build surfaced (notably: live-Pi approval suspend/resume, and governing Pi's built-in tools).

**Definition of done (every milestone).** A milestone is not complete until both of
these are green in CI:

1. **Unit tests** covering the milestone's new components and their failure modes.
2. **An automated demo** — a single command (`make demo-mN`, also a CI job) that drives
   the milestone's exit scenario end-to-end with **no manual steps** and asserts the
   outcome. External surfaces and providers are driven by **recorded payloads, fakes, or
   sandboxes** (e.g. `marathon dev slack-event sample.json`, a fake GitHub/Slack API, a
   mock or recorded model provider), so demos are deterministic and run in CI. The demo
   scripts live in `demos/mN/` and double as living integration tests; later milestones
   re-run earlier demos to guard against regressions.

Each milestone below states its **Human prerequisites** (external setup only a person can
do — accounts, API keys, app registrations, secrets, security sign-offs — which the
implementer cannot perform), its unit-test focus, and its automated demo. Human
prerequisites are **cumulative** (later milestones assume earlier ones are in place).

---

### M0 — Foundations & data model
**Goal:** a running skeleton with the schema and infra everything else builds on.

Human prerequisites:
- Create the project's **source repository** and enable **CI** (e.g. GitHub Actions),
  granting CI the secrets/permissions it needs.
- Provision the **master encryption key / secret-store backend** (the key the app uses to
  encrypt secrets at rest).
- Confirm the **open-source license** (Apache 2.0 vs MIT) so it can be committed.

Build:
- Monorepo + Docker Compose (Postgres, app, worker), config loading, secret store
  abstraction (encrypted DB field or external manager), CI, migrations tooling.
- Core schema (`design.md` §10): Tenant, User + UserIdentity, Agent, AgentVersion,
  Task, TaskStep, ModelInvocation, ToolInvocation, ApprovalRequest, Feedback,
  AuditEvent, DocumentArtifact. All tenant-scoped.
- Task **state machine** types + transition guards (no execution yet).
- Audit-event writer; structured logging + OpenTelemetry baseline.

Depends on: nothing.
Exit criteria — unit tests + automated demo:
- *Unit tests:* schema constraints, tenant-scoping guards, task state-machine
  transitions (valid and rejected), audit-event writer.
- *Automated demo* (`make demo-m0`): bring up Compose, apply migrations, create a Tenant
  + Task and drive it through the state machine; assert the final state and audit rows.

---

### M1 — Durable task spine (the heart)
**Goal:** durable, idempotent, resumable task execution with **no surfaces and no real
agent yet** — driven by a synthetic step function injected via internal API.

Human prerequisites:
- None beyond M0 — this milestone is pure internal code on the local Compose infra
  (only adequate CI runner capacity is assumed).

Build:
- **Task Orchestrator:** lifecycle, step scheduling, checkpoint persistence, resume
  after crash, dead-letter on terminal failure.
- **Postgres-backed queue:** enqueue/lease/heartbeat/ack; worker leases; visibility
  timeouts; kept workflow-engine-compatible (Temporal swappable later).
- **Agent Worker** shell: pulls leased work, runs a step, checkpoints, releases.
- **Idempotency** keys (`surface_type+external_event_id`, `task+tool+input_hash`);
  **automatic retry** with backoff for transient errors; durable-wait state plumbing.

Depends on: M0.
Exit criteria — unit tests + automated demo:
- *Unit tests:* queue lease/heartbeat/ack/visibility-timeout, checkpoint
  serialize/restore, idempotency-key dedupe, retry/backoff error classifier,
  dead-letter transition.
- *Automated demo* (`make demo-m1`): enqueue a synthetic multi-step task; the harness
  kills the worker mid-run; a fresh worker resumes from checkpoint and completes
  **exactly once**; a duplicate enqueue is asserted to be a no-op.

---

### M2 — Pi harness + minimal model gateway
**Goal:** a real agent loop runs inside a durable task and produces output.

Human prerequisites:
- Obtain **Pi harness access** — repo/package access, license, API docs, and any auth
  token. (Blocks the §6.1 approval-resume spike.)
- Create **model-provider accounts + API keys with billing and spend caps** — Anthropic
  (Claude), OpenAI (ChatGPT), OpenRouter — and load the keys into the secret store.
- Run the demo **once with live keys** so deterministic provider fixtures can be recorded;
  CI uses the recordings thereafter.

Build:
- Integrate **Pi in-process** (`@earendil-works/pi-coding-agent` SDK: `createAgentSession`)
  as the agent loop inside the Agent Worker; subscribe to its event stream.
- **Persist the Pi session JSONL per task** as the durable checkpoint + full trace; map
  Pi's turn/step boundaries onto `TaskStep` checkpoints.
- **Minimal Model Gateway:** Claude / ChatGPT / OpenRouter (OpenRouter as an
  OpenAI-compatible provider); **inject per-tenant keys at runtime** (`setRuntimeApiKey`);
  record `ModelInvocation` with **cost read from Pi** (model cost metadata + session stats).
- Full **trace logging on by default** (the session JSONL; redaction via the `tool_result`
  hook; configurable later).

Depends on: M1, the §6.1 approval-resume spike.
Exit criteria — unit tests + automated demo:
- *Unit tests:* Pi-step ↔ TaskStep mapping, model-gateway routing, cost/token
  computation per provider (incl. OpenRouter normalization), trace-redaction toggle.
- *Automated demo* (`make demo-m2`): run a "hello agent" task against a recorded/mock
  model provider; assert the structured result and the `ModelInvocation` + cost rows;
  kill the worker mid-loop and assert a clean resume.

---

### M3 — Tool layer (embedded permissioning) + first tools
**Goal:** the agent can use tools, with permissioning enforced inside Pi and policy/
credentials/audit owned by Marathon.

Human prerequisites:
- Create a **GitHub read identity** — a GitHub App or fine-grained token with read scopes —
  and a **sandbox repo** seeded with sample files/PRs/issues; load the credential into the
  secret store.
- Approve the initial **command-line tool allowlist** (a security decision: which CLIs
  agents may run).

Build:
- **Tool layer in Pi** via the `tool_call` hook (permission check, destructive detection,
  block, and credential injection by mutating input) and the `tool_result` hook (redaction
  + `ToolInvocation`/audit logging). Input-schema validation + rate limits.
- **Tool policy** model + tool grants on AgentVersion.
- **Command-line tools** via Pi's built-in `bash` tool (primary), under the policy hook;
  plus a **GitHub read-only connector** (read file/PR/issue, search) as custom tools. MCP
  stubbed behind the same interface (full MCP later).
- **Execution isolation** (Pi has no sandbox): run the worker+Pi in a container and route
  tool execution (esp. `bash`/writes) through a sandbox — Gondolin / Docker / OpenShell.
  (Hardened further in M9; see `design.md` §12.6.)
- Risk levels + default policy table (`design.md` §7.8).

Depends on: M2, §1.2/§1.3 contracts.
Exit criteria — unit tests + automated demo:
- *Unit tests:* policy evaluation (allow/deny/destructive/approval flags), credential
  injection + redaction, input-schema validation, rate limiting.
- *Automated demo* (`make demo-m3`): an agent task uses GitHub-read (recorded fixtures)
  + a CLI tool under policy; an out-of-policy call is asserted blocked **and** audited;
  the trace is asserted to contain **no** credential material.

---

### M4 — Slack surface (first end-to-end user flow)
**Goal:** a user can invoke an agent from Slack and get a durable, tool-using answer.

Human prerequisites:
- Create and configure the **Slack app** (single `@marathon` bot): scopes, event
  subscriptions, slash commands, signing secret, bot token; **install it to a test Slack
  workspace** you administer. Load the signing secret + bot token into the secret store.
- Provide a **public HTTPS endpoint or tunnel** (e.g. ngrok) for Slack event delivery in
  live dev. (CI uses recorded payloads.)

Build:
- **Slack Gateway:** events API, signature verify, dedupe, fast ack, normalize → enqueue.
- **Invocation Router:** resolve `@marathon <agent>` (+ **default-agent selection**),
  authz (tenant / channel / user), create task, attach context.
- **Surface Delivery (Slack):** threaded reply, rate-limited progress updates,
  structured-result rendering with silent cost footer.
- **Feedback:** 👍 / 👎 (+ optional text) captured → `Feedback`.
- First example agent: **Bruce** (read-only investigation).

Depends on: M3, §1.1 `SurfaceAdapter`.
Exit criteria — unit tests + automated demo:
- *Unit tests:* Slack signature verify, event dedupe, invocation parsing +
  default-agent resolution, structured-result → Slack rendering.
- *Automated demo* (`make demo-m4`): feed a recorded Slack `app_mention`
  (`marathon dev slack-event …`) into the gateway with a **fake Slack API**; assert a
  durable task runs read tools and produces a threaded reply + captured feedback; a
  replayed duplicate event is asserted **not** to double-run.

---

### M5 — Approval (destructive-only) + durable waits + write tools
**Goal:** destructive actions pause for in-place human approval and resume durably.

Human prerequisites:
- Grant the GitHub identity **write scopes** (issues, PRs) and re-install on the sandbox
  repo.
- Enable **interactivity + a request URL** in the Slack app so approval buttons work.
- Provide a **safe sandbox for the destructive example** — a throwaway repo plus a
  stub/sandbox deploy-or-rollback target — so the gated action can be exercised without
  real-world harm.

Build:
- **Approval orchestration (block-persist-resume):** the `tool_call` hook blocks a
  destructive call → persist the Pi session JSONL, set `waiting_for_approval`, post the
  in-place prompt, tear down the worker (**no process held**); on approve, re-open the
  session and re-enter (re-prompt or fork — per the §6.1 spike). Expiration + re-notify,
  `ApprovalRequest` + audit.
- Handle reject/edit paths; record the decision as a Pi `custom` session entry.
- **GitHub write tools:** create issue / comment / open PR (**non-destructive → no
  approval**); one destructive example (e.g. merge / rollback) **gated**.
- Write-action idempotency so a retry/duplicate never double-executes.

Depends on: M4, M1 durable waits.
Exit criteria — unit tests + automated demo:
- *Unit tests:* approval state transitions, expiration/re-notify, write-action
  idempotency, destructive-detection mapping.
- *Automated demo* (`make demo-m5`): a task proposes a destructive call → assert it
  enters `waiting_for_approval` with no execution; inject a simulated **approve** event →
  assert a single execution; a second run with **reject** → assert no action; simulate a
  worker restart during the wait → assert the wait survives and then resumes.

---

### M5.5 — Live Slack app (end-to-end Socket Mode listener)
**Goal:** a persistent process lets a user `@marathon …` in Slack and get a real,
tool-using, **threaded reply** end-to-end — stitching M2–M5 into something you can
actually talk to. (The earlier milestones proved each piece; this runs them live.)

Human prerequisites:
- Bot installed in a channel (**#general — done**); app-level (`xapp-`) + bot
  (`xoxb-`) tokens in `.env` (**done**).
- A host to run the long-lived listener (local/dev is fine now; a deploy target later).

Build:
- **Socket Mode listener** — connect via `apps.connections.open`, handle
  `hello` / `disconnect` / reconnect, and **ack each envelope** promptly.
- **Dispatch** — `app_mention` → dedupe (event id) → `parseAppMention` →
  `InvocationRouter` → durable task; the worker runs the **Pi agent (OpenAI default)
  + tools under policy**; `SlackDelivery` posts ack → progress → the threaded
  structured result (silent cost footer).
- **Feedback** — `reaction_added` → `recordFeedback`.
- **In-thread approvals** — a destructive tool call → `ApprovalService` posts the
  prompt in-thread (interactivity buttons or a reply convention); approve/reject
  resumes the task (block-persist-resume).
- Graceful reconnect; at-least-once delivery made safe by event-id dedupe.

Depends on: M2, M3, M4, M5.
Exit criteria — unit tests + automated demo:
- *Unit tests:* Socket Mode envelope parsing + ack, and event dispatch routing
  (mention vs reaction vs interactivity).
- *Automated demo* (`make demo-slack-app`): feed recorded Socket Mode envelopes
  through the dispatcher with a fake Slack client + fake agent → assert a threaded
  reply and recorded feedback; a duplicate envelope is a no-op.
- *Live smoke* (`make smoke-slack-app`): mention `@marathon …` in #general → a real
  threaded reply via a live model call.

---

### M6 — GitHub document surface + document-driven workflow
**Goal:** documents are a first-class surface; the draft-→review-→merge-→execute loop works.

Human prerequisites:
- Extend the **GitHub App for webhooks**: set the webhook URL + secret, subscribe to
  `issue_comment` and `pull_request_review_comment`, and install on the sandbox repo;
  provide a **public endpoint/tunnel** for webhook delivery in live dev.
- Provide a **sandbox repo with merge rights / branch protection** configured for the
  design-doc → review → merge flow.

Build:
- **Document Gateway:** GitHub webhooks (`issue_comment`, `pull_request_review_comment`),
  `@marathon <agent>` mention detection, anchor resolution (repo/path/line/comment id),
  repo-permission checks (user + agent).
- **`document.*` tools:** read / read_region / create / update (via branch + PR) /
  comment / reply_to_comment; **git-SHA idempotency** + re-validate/rebase before write.
- **Surface Delivery (GitHub):** comment replies, PR links; structured result rendered
  as markdown via templates (postmortem / PRD / release notes).
- **DocumentArtifact** tracking (produced / watched, repo+path, last SHA).
- **Document-driven journey** (`design.md` §6.8): agent drafts a design-doc PR →
  people comment → agent revises → **human merges = approval** → agent executes.
- Second example agent: **Quill** (document agent).

Depends on: M5 (reuses approval + GitHub connector), §1.1 `SurfaceAdapter`.
Exit criteria — unit tests + automated demo:
- *Unit tests:* webhook parse (`issue_comment` / `pull_request_review_comment`), anchor
  resolution, git-SHA idempotency + stale-SHA rejection, markdown templating.
- *Automated demo* (`make demo-m6`): feed a recorded PR-comment webhook (against a
  **fake/sandbox GitHub**) → assert an agent reply and an opened PR; feed a simulated
  **merge** webhook for a design-doc PR → assert execution starts with progress posted to
  both the PR and Slack.

**← MVP complete here.**

> **M6 completion status.** Core loop + exit-demo are done & CI-green. Added later:
> **repo-permission checks** (agent + invoking user, §7.17), **output templates**
> (postmortem/PRD/release-notes), and **`document.reply_to_comment`**. Carried into later
> milestones: prompt/persona + revision loop + watched-docs → **M7**; cross-surface progress
> → **M8**; rebase-on-conflict → **M9**.

---

## 2a. Live-integration follow-ons

> Surfaced during the MVP build. The components (tool layer, approvals, document
> surface) are built and tested; the demos/CI exercise them with fakes. These two
> milestones wire them into the **live** agent loops. Not required for the MVP; they
> make the running system use governed tools and live document webhooks.

### M6.1 — Governed tools in the live agent (Pi `tool_call` hook)
**Goal:** the live agent (Slack or document) uses Marathon-governed tools through the
Pi harness — not just Pi's built-in read tools — so policy, credential injection,
audit, and **in-thread approvals** apply to a real model-driven run.

Human prerequisites:
- None new (uses existing model + GitHub credentials).

Build:
- Register a Pi **`tool_call` hook** (via `DefaultResourceLoader` extension factory)
  that runs each call through `ToolGateway.evaluate` → block / inject credentials /
  detect destructive; and a **`tool_result` hook** for redaction + `ToolInvocation`
  audit (per `pi-details.md` §3, design §7.8).
- Expose Marathon tools to Pi (GitHub read/write, `document.*`, CLI) as Pi custom
  tools (`defineTool`) backed by our connectors.
- On a destructive call, drive the **block-persist-resume** approval (M5) and post the
  prompt **in-thread** on the originating surface; resume on approve.

Depends on: M3, M5, M5.5 (and M6 tools).
Exit criteria — unit tests + automated demo:
- *Unit tests:* the `tool_call`/`tool_result` hook adapters (block, mutate/inject,
  redact) over a fake Pi tool-call event.
- *Automated demo* (`make demo-m6.1`): a fake Pi run that emits a non-destructive and
  a destructive tool call → assert the first executes + is audited, the second is
  blocked pending approval, and approve → executes once.
- *Live smoke* (`make smoke-pi-tools`): a real model run that uses a governed GitHub
  read tool end-to-end.

### M6.2 — Live document app (GitHub webhook receiver)
**Goal:** real inbound GitHub document events drive the pipeline live (the parallel
of M5.5 for documents) — `@marathon` in a PR/issue comment gets a real reply, and a
merge triggers execution.

Human prerequisites:
- A **GitHub App (or webhook) + a public endpoint/tunnel** (e.g. ngrok) and the
  webhook secret in `.env`; subscribe to `issue_comment`,
  `pull_request_review_comment`, `pull_request`.

Build:
- An HTTP **webhook receiver** (Fastify) that verifies the signature
  (`verifyGithubSignature`), dedupes by delivery id, and dispatches via
  `classifyGithubEvent` → the same router/worker/`GithubDelivery` pipeline as the
  M6 demo.
- A `github-app` wiring (parallel to `slack-app`): bootstrap tenant-by-repo, mention
  → draft/answer, merge → execute.

Depends on: M6 (and M6.1 for governed tools in the live run).
Exit criteria — unit tests + automated demo:
- *Unit tests:* webhook request handling (signature reject, delivery-id dedupe,
  dispatch routing).
- *Automated demo* (`make demo-github-app`): POST recorded webhook payloads (signed)
  to the receiver with fakes → assert a reply comment and, on a merge payload,
  execution.
- *Live smoke*: comment `@marathon …` on a PR in the sandbox repo → a real reply
  (requires the tunnel).

---

### M7 — Memory & feedback-to-memory
**Goal:** agents carry context across a conversation and over time, and learn from feedback so
a corrected mistake isn't repeated — behind a **swappable memory store** (design §7.12).

> **Status — M7 done & CI-green.** `MemoryStore` seam, `PgVectorMemoryStore` (default) +
> `FakeMemoryStore`, `Mem0MemoryStore` (smoke), `FakeEmbedder`/`OpenAIEmbedder`, project=repo
> resolver, feedback→memory, and prompt assembly (§7.18) loading personas + injecting recalled
> memory — wired into **both** the live Slack app and the GitHub app. DB on
> `pgvector/pgvector:pg16`. Carry-overs delivered: **document revision loop** (#3 — `document.revise`
> commits to the draft PR's branch on a follow-up comment) and **watched documents** (#8 — a
> `push` to a watched path bumps `last_revision_seen` and spawns a review task). Deferred as
> planned: LLM fact-extraction/consolidation, Zep adapter.

Human prerequisites:
- Ensure the **embeddings key** is in the secret store (OpenAI `text-embedding-3-small`;
  usually covered by the M2 provider account). pgvector runs in Compose — no human setup.
- For the live Mem0 smoke only: a **Mem0 endpoint + key** (hosted or self-hosted) in `.env`.

Design decisions (settled — design §7.12):
- **Scope × term** model: scopes = **tenant / project / agent / thread**; terms = short / long.
  `recall` unions all applicable scopes and **searches both terms** (caller never picks a term).
- **Project = GitHub repo** (`owner/name`) via a pluggable resolver; project memory is gated by
  the repo-permission check (§7.17).
- **Task short-term is NOT in the store** — it's the existing Pi session + checkpoint; the
  store's short-term tier is thread-level.
- **Store-and-retrieve only** this milestone — no LLM fact-extraction / consolidation yet.

Build:
- **`MemoryStore` interface** (`remember` / `recall` / `forget` / `list`) — the swappable seam.
- **`PgVectorMemoryStore`** (default, in-repo) + a `FakeMemoryStore` for tests; pgvector schema
  (`memory_item` + embeddings), tenant-isolated + repo-permission-filtered, recall ranks
  relevance blended with recency within a token budget, with TTL + retention/`forget`.
- **`Mem0MemoryStore`** adapter — first external backend (validates the seam; client SDK
  against a Mem0 service, not embedded in-process).
- **Writes:** task **result summaries** → long-term; **feedback corrections** (👎 + text) →
  agent-scoped long-term; **thread turns** → short-term (TTL).
- **Recall wired into prompt assembly** (§7.18) so agents actually use memory.
- **Prompt & context assembly (§7.18)** — load `AgentVersion.instructions` (give **Quill** /
  **Bruce** real personas) + per-surface context builder with untrusted-content delimiting.
  *(M6 carry-over #2.)*
- **Document revision loop (§6.8)** — agent revises a drafted doc PR in response to review
  comments before merge. *(M6 carry-over #3.)*
- **Watched documents** — populate the `watched` role + `last_revision_seen`; react when a
  tracked document changes. *(M6 carry-over #5.)*

Deferred to later: LLM **fact-extraction / consolidation** (short→long promotion), Zep adapter.

Depends on: M4 (feedback), M6 (repo permission), M6.1 (governed tools).
Exit criteria — unit tests + automated demo (+ live smoke):
- *Unit tests:* scope×term modeling, recall ranking across scopes searching both terms,
  tenant + project-permission filtering, feedback → memory write, TTL/retention `forget`.
- *Automated demo* (`make demo-m7`, pgvector + fakes): seed a corrective feedback, run a later
  task in the same scope, assert recall surfaces + the prompt applies the correction; assert a
  different tenant/project does **not** see it; assert `forget` removes it.
- *Live smoke* (`make smoke-mem0`): `remember` + `recall` round-trip against a real Mem0
  service through the same interface.

---

### M8 — Inspectability, cost & observability
**Goal:** every task is explainable; cost and health are visible.

Human prerequisites:
- If exporting telemetry externally, provision an **observability backend** (OTel
  collector + a backend like Grafana/Honeycomb) and its credentials. (Local-only needs
  none.)
- Decide and provide **budget limit values** (per task / agent / tenant), plus any
  provider **usage-API access** for cost reconciliation.

Build:
- **Inspectability dashboard** (the one user/admin-facing view): per-task timeline,
  model + tool calls, data seen, cost, failures, prompt/model versions.
- Cost rollups (per task/agent/tenant/model), **silent by default**, surfaced on
  completion + on threshold breach; budgets enforced from actuals.
- Metrics (queue depth, success/latency, tool/model error rates, retries, dead-letter),
  OpenTelemetry traces, failure analytics.
- **Cross-surface progress** — a task initiated on one surface (e.g. a GitHub mention)
  can post progress/status to the requesting user on another (e.g. Slack). *(M6 carry-over #8.)*

Depends on: M2/M3 (invocation records), M5 (approvals).
Exit criteria — unit tests + automated demo:
- *Unit tests:* timeline assembly from invocation/audit rows, cost rollups, budget
  enforcement, metric emitters.
- *Automated demo* (`make demo-m8`): run a task, then assert the inspectability API
  returns a complete timeline (model/tool calls, data seen, cost, failures); drive spend
  past a budget and assert further spend is blocked.

---

### M9 — Hardening, security & self-host polish
**Goal:** trustworthy enough to self-host and demo as open source.

Human prerequisites:
- Arrange a **security review / sign-off** of the trust boundaries (a human reviewer), and
  optionally an external **penetration test**.
- Finalize **data-retention policy values** per tenant / data class (a product/legal
  decision).
- Confirm the **license** is applied and grant any **release/branding approvals** needed to
  open-source the project.

Build:
- **Security pass on the trust boundaries** (`design.md` §12): untrusted surface/tool
  output, secrets never in prompts, policy outside the model, tenant isolation, the
  **agent trust hierarchy** (frontier model sanitizes context for smaller models).
- **Harden execution isolation** — finalize the sandbox for tool execution (Gondolin /
  Docker / OpenShell), since Pi provides none (`design.md` §12.6).
- Prompt-injection tests (malicious doc body / comment / tool output).
- **Concurrent document edits** — rebase-before-write on a stale base SHA (today we safely
  *reject*; risk #7). *(M6 carry-over #6.)*
- Retention controls per tenant/data class; redaction rules; dead-letter UX.
- Docker Compose quickstart, README, architecture docs, internal agent-config flow,
  eval fixtures (surface-agnostic: Slack thread *or* document snapshot).

Depends on: all prior.
Exit criteria — unit tests + automated demo:
- *Unit tests:* redaction rules, retention enforcement, prompt-injection guards (the
  trust-hierarchy sanitization), tenant-isolation queries.
- *Automated demo* (`make demo-m9`): from a fresh clone, `docker compose up` and re-run
  the M4 + M6 demos green; run the prompt-injection suite (malicious doc/comment/
  tool-output fixtures) and assert no policy bypass and no instruction-following from
  untrusted content.

---

## 2b. Learned since build (new / re-prioritized work)

Surfaced while implementing M0–M6.2. These update the plan based on what the code taught us;
fold into M7–M9 sequencing as capacity allows.

1. **Live-Pi approval suspend/resume** *(promote to its own milestone; depends on M5, M6.1).*
   The approval engine exists at the orchestration layer, but suspending an in-flight Pi turn
   and re-entering on approval is unbuilt. Run the §6.1 spike (re-prompt vs. fork), then wire
   in-thread approve → resume into the live Slack/GitHub apps. **This is the headline gap.**
2. **Govern Pi's built-in tools** *(security; pairs with M9).* `read/grep/find/ls` currently
   bypass the `ToolGateway`. Either route built-ins through the gateway via the `tool_call`
   hook, or replace them with governed equivalents — otherwise the chokepoint is bypassable.
3. **Execution isolation** *(M9, now the top security gap).* No sandbox today; with #2 open,
   enabled built-ins run unsandboxed and unaudited. Gondolin/Docker/OpenShell + credential
   injection at execution.
4. **Durable resume of a *real* Pi run** *(reliability).* `PiAgentRuntime` runs single-turn;
   the per-turn checkpoint/resume path is only exercised by fake agents. Build a multi-turn
   tool loop with per-turn checkpointing so a crashed in-flight model run resumes.
5. **Document revision loop** *(done in M7).* A follow-up `@marathon` comment on a drafted PR
   now revises the doc on its branch (`document.revise`) instead of opening a new PR.
6. **Prompt & context assembly + model selection** *(now specified — design §7.18, §7.19;
   scheduled: M7, budgets M8).* Today the agent gets a generic hardcoded instruction + the raw
   mention text. Build the real prompt builder: load `AgentVersion.instructions`, add a
   per-surface context builder (Slack thread / document region + memory) with untrusted-content
   delimiting (§12.2), and implement real model selection (role→tier routing, constraint/budget
   filter, fallback, per-tenant policy).
7. **Testing conventions to keep** *(process).* The **deterministic demo (fakes/fixtures, CI)
   + live smoke (real services, local)** split worked well and caught real bugs. Rule learned
   the hard way: **await all side effects in demos** — a fire-and-forget audit write made the
   M3 demo flaky in CI (now fixed by awaiting recorder writes).

---

## 3. Dependency / critical path

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M5.5 ─► M6 ─► M6.1 ─► M6.2   ✅ all done (MVP + follow-ons)
                   │            └► M7  ⏳ next
                   └────────────► M8 (can start after M3, matures after M5)
                                  M9 runs continuously, gates the MVP release
```
**M5.5** (live Slack app) integrates M2–M5 into a runnable end-to-end listener.
**M6.1 / M6.2** (§2a) are the post-MVP live-integration follow-ons (governed tools via custom-
tool delegation; a GitHub webhook receiver). The originally-planned approval-resume spike was
**not** on the built critical path — the approval engine lives at the orchestration layer (M5),
and the live-Pi suspend/resume is now an explicit follow-on (**§2b #1**).

---

## 4. Cross-cutting, built in from the start

- **Idempotency & exactly-once effects** — established in M1, honored by every write
  tool (M5) and document edit (M6).
- **Durability** — checkpoints at every `TaskStep`; no state only in process memory.
- **Security** — credentials injected only at tool execution; trace redaction; tenant
  scoping on every query. Hardened in M9 but enforced as code is written.
- **Observability** — invocation/audit records written from M2/M3; dashboard in M8.
- **Testing** — **every milestone ships unit tests + an automated demo** (`make demo-mN`
  in `demos/mN/`, run in CI; see §2 Definition of done). Demos use recorded payloads /
  fakes / sandboxes so they're deterministic, and later milestones re-run earlier demos
  as regression guards. A **replay** harness (re-run a recorded task) lands in M2; eval
  fixtures in M9. A top-level `make demo` runs the whole chain.

---

## 5. Out of scope for MVP (explicit)

User-initiated cancellation · multi-tenant enterprise mgmt / SSO / advanced RBAC ·
external agent/connector/SDK builder experience · document providers beyond GitHub
markdown (Google Docs, Notion — on request) · per-agent Slack identities · advanced
(cost/quality) model routing · scheduled/recurring tasks · full vector knowledge base.

---

## 6. Key risks & open questions

1. **Pi durable approval wait — PARTIALLY BUILT; the live-Pi half is the top open risk.**
   The durable approval *engine* is built and tested at the Marathon **orchestration layer**
   (block/approve/reject/expire, survives worker restart, idempotent — M5). **Not yet built:**
   suspending an in-flight **Pi** turn and re-entering it on approval. Block-persist-resume is
   the chosen approach, but the spike to pick the re-entry mechanism —
   (a) re-prompt-to-continue or (b) fork-before-the-blocked-call — has **not** been run; M6.1
   currently just returns "approval required" to the model. Promoted to a follow-on in §2b.
   See `pi-details.md` §6.3.
2. **Tool interception — RESOLVED, but via a different mechanism than planned.** Embedded
   permissioning is implemented by registering Marathon tools as Pi **custom tools that
   delegate to the `ToolGateway`** (the chokepoint: policy, credential injection, audit,
   redaction). **Caveat:** Pi's **built-in** tools (`read/grep/find/ls`) bypass the gateway —
   governing/replacing them is tied to the sandbox work (risk #3, M9). The `tool_call` hook
   remains available if we later need to gate built-ins (`pi-details.md` §3 As-built).
3. **Pi has no built-in sandbox — UNADDRESSED; now the top security gap.** It runs with the
   user's full OS permissions, and (per risk #2) enabled built-in tools run ungoverned against
   the worker filesystem. Marathon must add OS-level isolation and route tool execution (esp.
   `bash`/write tools) through a sandbox — Gondolin micro-VM, Docker, or OpenShell (deferred to
   M9; `pi-details.md` §7).
4. **GitHub identity & mentions** — the bot's GitHub App login, comment-vs-review webhook
   coverage, and rate limits for the document surface (M6).
5. **Default-agent selection** quality (M4) — start with simple capability/keyword routing;
   treat as iterative.
6. **Cost/token attribution** via OpenRouter vs direct — mostly handled by reading Pi's cost
   metadata; normalize provider differences in the minimal gateway (M2). *As-built:* cost is
   read per call from the turn's assistant message (`usage.cost.total`) and captured as a
   `ModelInvocation`; budget **enforcement** is M8.
7. **Concurrent document edits** — base-SHA validation/rebase strategy before writes (M6).

---

## 7. First demo (proves the spine end-to-end)

This is the **automated** `make demo-m4` scenario (extended by `make demo-m6`), not a
manual walkthrough — it runs in CI against fakes/recorded fixtures.

Target after **M4** (Slack + read tools), extended at **M6** (documents):

> `@marathon bruce summarize this PR and flag risks` → durable task → reads the PR via
> GitHub + CLI tools → posts a threaded risk summary with a silent cost footer →
> accepts 👍/👎. No approval (non-destructive). The full trace is inspectable.

Then the headline doc flow at M6:

> Ask in Slack → Quill drafts a design-doc PR → team comments → Quill revises → a human
> merges (= approval) → Quill executes the plan, posting progress to the PR and Slack.
