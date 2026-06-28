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

---

### M7 — Memory & feedback-to-memory
**Goal:** agents carry context across a task/thread and learn from feedback.

Human prerequisites:
- Confirm **embeddings access** (which provider/model for retrieval) with billing —
  usually covered by the M2 provider accounts; ensure the embeddings key is in the secret
  store. (pgvector itself runs in Compose — no human setup.)

Build:
- Task-local, thread, and agent memory; **tenant knowledge** retrieval via pgvector;
  permission-filtered, inspectable, deletable, configurable retention.
- **Feedback incorporated into agent memory / future context** so a corrected mistake
  isn't repeated.

Depends on: M4 (feedback), M6.
Exit criteria — unit tests + automated demo:
- *Unit tests:* memory scoping + permission filtering, retrieval ranking, feedback →
  memory write, deletion.
- *Automated demo* (`make demo-m7`): seed a corrective feedback, run a later task, and
  assert it retrieves and applies the correction; assert permission-filtered retrieval
  excludes unauthorized content; assert deletion removes it.

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

## 3. Dependency / critical path

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6  (= MVP)
                   │            └► M7
                   └────────────► M8 (can start after M3, matures after M5)
                                  M9 runs continuously, gates the MVP release
```
Critical path runs through the **§6.1 approval-resume spike** (blocks M2 design) and
the **approval durable-wait** (M5). Start the spike during M0/M1.

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

1. **Pi durable approval wait (highest, but de-risked).** §6.1 — Pi has no native multi-day
   suspend; the approach is **block-persist-resume** (the `tool_call` hook blocks the
   destructive call, Marathon persists the Pi session JSONL and tears down, then re-opens
   the session on approval). **Spike in M0/M1** to pick the re-entry mechanism:
   (a) re-prompt-to-continue, or (b) fork-before-the-blocked-call and re-run with policy now
   allowing. See `pi-details.md` §6.3.
2. **Pi tool-call interception — RESOLVED.** Pi exposes `tool_call` (block/mutate) and
   `tool_result` (redact/log) hooks; embedded permissioning + credential injection are
   confirmed (`pi-details.md` §3).
3. **Pi has no built-in sandbox.** It runs with the user's full OS permissions. Marathon
   must add OS-level isolation and route tool execution (esp. `bash`/write tools) through a
   sandbox — Gondolin micro-VM, Docker, or OpenShell (M3, hardened in M9; `pi-details.md` §7).
4. **GitHub identity & mentions** — the bot's GitHub App login, comment-vs-review webhook
   coverage, and rate limits for the document surface (M6).
5. **Default-agent selection** quality (M4) — start with simple capability/keyword routing;
   treat as iterative.
6. **Cost/token attribution** via OpenRouter vs direct — mostly handled by reading Pi's cost
   metadata + session stats; normalize provider differences in the minimal gateway (M2).
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
