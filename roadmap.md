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
| Agent runtime | **Pi** (in-process) **or Claude Code (headless)** behind `AgentRuntime` — one per deployment, per-agent override; wrapped by a durable worker |
| Tool permissioning | Gateway = **deterministic safety perimeter** (creds, redaction, audit, tenant isolation); enforcement via **credential scope + resource-native permissions**; high-risk via **Proposed Effects** (§7.9, `policy.md`) |
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

### 1.3 `ToolGrant` (construction-time tool wiring — not a runtime policy)
```ts
interface ToolGrant {
  tool: string;
  riskAxes: { reversible: boolean; crossesTrustBoundary: boolean;
              audience: 'private'|'project'|'tenant'|'external'; costly: boolean };
  defaultMode: 'autonomous'|'native_review'|'proposed_effect'|'disabled';   // §7.8
  constraints?: { repos?: string[]; readonly?: boolean };  // read-scoping (least-privilege reads)
  credentialRef: string;          // resolved + injected at exec, never shown to model
  rateLimit?: RateLimit; redaction?: RedactionRule[];
}
```
A grant decides which tools get **registered** into the agent's session and how their effects
route (§7.8); it is not a runtime permission check. Enforcement lives in credential scope,
resource-native permissions, and the egress policy (`policy.md` §11); the `ToolGateway` is
mechanical plumbing (credentials, read ledger, egress routing, redaction, audit).

### 1.4 Durable task records
`Task`, `TaskStep`, `ModelInvocation`, `ToolInvocation`, `ApprovalRequest` per
`design.md` §10. Source identity lives in `source_type` + `source_ref` (no Slack
columns in core tables).

---

## 2. Milestones

MVP = **M0–M6** (both surfaces, durable agent tasks, GitHub tools, destructive-only
approval, the document-driven workflow, basic feedback). M7–M9 round it out.

> **Status (build progress).** ✅ **Done & CI-green:** M0–M6, **M5.5**, **M6.1** (governed
> tools, now wired into the live Slack agent too), **M6.2**, **M7** (memory), **M8** (core
> inspectability/cost/budgets) — each runtime-verified against real OpenAI / GitHub / Slack.
> ⏳ **Remaining:** **M9** (hardening + sandbox — Docker backend + broker + Pattern-2 tool routing
> landed), **M10** (**Proposed Effects** — propose→review→execute + Agent Hub; see `policy.md`), and
> **M11** (the frontier-orchestrated **loop** — design §28). The **meta-harness organ map (design §28)** frames
> Marathon as a Layer-2 orchestrator: strong on governor + state + isolation; the loop is M11.
>
> **⚠ Kernel focus (2026-07-02 — supersedes the ordering above).** Marathon has no customers
> yet; the priority is the **core kernel loop** (design **§0** / `design/00-core-kernel.md`):
> Slack ask → design-doc PR → iterate via comments/questions → merge-as-approval → sandboxed
> code implementation → code PR, delivered back to the thread and the doc. **Build the kernel
> milestones K1–K7 (§2c below; gaps identified in design §0.3) before anything else** —
> chiefly K1 (code-writing path end-to-end: clone → sandboxed edit/test → governed branch
> push → PR), K2 (loop task chain + `delivery_targets`), and K4 (durable resume, §2b #4). **Deferred
> behind the kernel:** M10, M11, §2b #9 (memory refactor), §2b #10 (identity linking), and the
> remaining M9 non-essentials (microVM, uid mapping). The kernel needs zero in-app approvals
> (all approvals are native PR merges), so nothing in M10 blocks it. Exit bar: **Marathon
> codes Marathon** — the loop is the default way changes to this repo get made (design §0.6,
> the ratchet: first merged Marathon-authored change → default path → stranger-ready);
> `make demo-kernel` is the CI guard beneath it.

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
  timeouts. **Temporal-shaped semantics, no swap hedge** — the engine is owned (design
  §18.2, §22.3).
- **Agent Worker** shell: pulls leased work, runs a step, checkpoints, releases.
- **Idempotency** keys (`surface_type+external_event_id`, `task+tool+input_hash`);
  **automatic retry** with backoff for transient errors; durable-wait state plumbing.

Depends on: M0.
Exit criteria — unit tests + automated demo:
- *Unit tests:* queue lease/heartbeat/ack/visibility-timeout, checkpoint
  serialize/restore, idempotency-key dedupe, retry/backoff error classifier,
  dead-letter transition.
- *Automated demo* (`make demo-m1`): enqueue a synthetic multi-step task; the harness
  kills the worker mid-run; a fresh worker resumes from checkpoint and completes, with side
  effects applied **at most once** (at-least-once delivery + idempotent effects); a duplicate
  enqueue is asserted to be a no-op.

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

### M3 — Tool layer (governed via the ToolGateway) + first tools
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
> **Superseded (2026-07-03):** the scope model below (agent as a scope, agent-scoped
> corrections) was replaced by the audience model — see §2b #9; migration Track 13
> implemented it (audience-gated recall, user-scoped corrections, migration 0009).

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

> **Status — core done & CI-green.** `@marathon/observability`: per-task **timeline** +
> `getTaskReport` (model/tool/approval/audit, cost, failures, prompt versions), **cost rollups**
> (by model/agent/task), a **metrics** snapshot (tasks/jobs by status, dead-letter, tool/model
> error rate), and **budgets** (`evaluateBudget`/`checkBudget`/`assertWithinBudget`) enforced in
> the agent step runner. **Remaining M8:** an inspectability **UI** (the data API is done),
> **OpenTelemetry** export (a thin hook over the metrics), and **cross-surface progress** (#8 —
> needs cross-surface identity linking).

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

> **Status — security core done & CI-green.** Defense-in-depth landed and tested
> (`make demo-m9`): **untrusted-content fencing** (`fenceUntrusted`, wired into prompt
> assembly), **policy-outside-the-model** (a fully-injected agent still can't run a
> destructive tool — no bypass), **secret redaction** in tool-output traces, **no implicit
> unsandboxed shell** (a `ToolSandbox` seam; `cli.run` refuses without `LocalSubprocessSandbox`/
> a real backend), **tenant isolation** on the inspectability reads, and **rebase-before-write**
> for concurrent doc edits (#6). **Docker sandbox backend landed:** `DockerSandbox` runs each
> command in an ephemeral, network-denied, credential-free, capability-stripped,
> resource-limited container (`dockerRunArgs` unit-tested for the isolation flags; live
> `make smoke-sandbox` verifies real execution + blocked egress); `sandboxFromEnv` selects the
> backend via `MARATHON_SANDBOX` (default `none`); built-ins are off by default (§2b #2). The
> **broker** for Pi-in-sandbox is being built in tested chunks: ✅ `Workspace` (ephemeral mount
> dir), ✅ the host-side tool broker (`handleToolRequest`, output redacted across the boundary),
> ✅ the broker **transport** (`serveToolBroker`/`ToolBrokerClient`, line-delimited JSON over a
> stream), and ✅ an **e2e proof** (`make smoke-broker`): a real container (no network, no creds,
> read-only, workspace-mounted) does FS work AND obtains governed-tool results only via the host
> broker (destructive → approval_required) — a stand-in for Pi validates the whole host/sandbox
> split. **Step-1 spike done** (`pi-details.md` §7): Pi calls the model itself, so the cleaner path
> is **Pattern 2 — Pi on the host + a tool-routing extension** (model/auth stay host-side, no
> model brokering) modeled on Pi's Gondolin example; the broker (chunks B–D) is the **Pattern 1 /
> remote** path. ✅ **Persistent `DockerContainer`** lifecycle (`start`/`exec`/`execStream`/`stop`,
> `make smoke-container`). ✅ **Pattern-2 tool routing landed:** `PiAgentRuntime` takes a `sandbox`
> option that routes Pi's `bash`/`read`/`write`/`edit` into the container (Pi's
> `create*ToolDefinition` + Docker-backed `*Operations`, supplied as `customTools` + allowlist since
> built-ins are off) while governed tools stay host-side — unit-tested, and proven end-to-end by
> `make smoke-pi-sandbox` (a real model run: agent `bash` reports the *container* hostname, a
> governed tool the *host* hostname, and a sandboxed `write` writes through to the host workspace).
> **Remaining M9 (staged):** route `grep`/`find`/`ls` too (today the model uses `bash`); a microVM
> (Gondolin) backend; consistent uid mapping; **retention** purge; the **trust-hierarchy** model
> sanitizer (§12.2); and docs/self-host polish. These gate a production release.
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
- **Harden execution isolation** — implement the sandbox runtime per the design in
  **`design/12-security-design.md` §12.6**: run the agent loop in a sandbox (Pi RPC) with a
  credential-free, egress-denied, ephemeral workspace; **broker credentialed tools to the host**
  gateway; **isolate code/FS tools** in the sandbox. Backends: Docker first, then microVM
  (Gondolin/Firecracker) / OpenShell. (Seam built in M9 core; `NoSandbox` refuses by default.)
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

### M10 — Proposed Effects (propose → review → execute) + Agent Hub

**Goal:** high-risk external effects are never direct model tools. The model calls one typed
`propose_effect` tool; a deterministic workflow routes the proposal; a **non-model executor**
performs approved effects using scoped tenant creds, **bound to the exact approved artifact**.
Folds in the durable-wait gap (§2b #1) and the deferred inspectability UI (M8). Full rationale +
options in [`policy.md`](./policy.md); design in **§7.8/§7.9, §12.1–§12.2, §14.1**.

**Model (settled — supersedes the old "destructive-only approval" framing).** *The model gets
Option B; the system gets a minimal Option C.* Reversible, bounded actions (read, create branch,
open PR, reply in the originating thread) run **autonomously** through the gateway. High-risk
effects — irreversible, cross-trust-boundary (**exfiltration** is the primary threat, not just
destruction), public/external, or costly — go through Proposed Effects. Enforcement of *what an
agent can do at all* lives in **credential scope + resource-native permissions** (branch
protection, roles), not a Marathon policy engine; the gateway is a **deterministic safety
perimeter**. **Prefer native handoff** (a PR the human merges) over in-app approval — approval
fatigue is real, so keep in-app approvals rare.

> **Code impact (pre-work).** This retires the single `tool.destructive` boolean that `enforce`
> currently gates on. Refactor to the multi-axis risk model (§7.8) + a `propose_effect` path
> before more connectors accrete against the old flag. Touches `ToolGateway`, the `Tool` type,
> and the governed GitHub tools already landed (M6.1).

Human prerequisites:
- For the hub: a place to **host the web app** + an **auth/SSO** provider (or use surface OAuth);
  decide who may approve (role/owner). Configure **least-privilege tenant creds** (prefer GitHub
  Apps) + **branch protection** on target repos.

Build (**phased**):

**Phase 1 — GitHub + Slack.**
- **`propose_effect` tool + typed effect schemas** (per connector) + a `ProposedEffect` record
  binding `effect_id · task · tenant · connector · effect_type · payload_hash · proposal_version ·
  provenance · reviewer_id(+authority) · approval_expiry · idempotency_key · execution_state`. The
  model never gets the high-risk tool directly.
- **Declarative router** (static config + deterministic predicates: connector, effect type,
  destination, audience, sensitivity, size, cost, reviewer role → autonomous / native_review /
  in_app_approval / disabled). *Not* a programmable policy DSL (that would recreate Option A).
- **Immutable proposals** — an edit creates a **new version**; approval binds to exactly one
  version + `payload_hash`.
- **Non-model executor.** Performs the approved effect with scoped tenant creds; **revalidates at
  execution** (tenant, credential, resource, destination, **payload hash**, approver authority);
  **idempotent / at-most-once** via `idempotency_key` (reuses M5 engine). The model cannot execute.
- **Async proposal + between-turn wait (§2b #1 — superseded design, 2026-07-01).**
  `propose_effect` **returns immediately** (`effect_id` + a `get_effect_status` monitor tool);
  the proposal is worked on the durable queue. The agent polls / does other work / ends its
  turn; if the task can't proceed, the *task* waits between turns (M5 engine; session JSONL
  persisted, no process held) and resumes with the outcome appended as the next turn's input.
  **No mid-turn Pi suspend — the §6.1 spike (re-prompt vs. fork) is obsolete.** At-most-once
  execution via `idempotency_key`.
- **GitHub default = PR-as-approval** (native handoff, ~zero in-app dialogs). **Slack replies route
  by type** (deterministic audience predicate, not a content classifier): status / clarifying /
  same-thread-summary → autonomous; a reply carrying private repo/doc context, a post outside the
  thread, external/shared channels, or broad mentions → `propose_effect`.
- **Reviewer authority (minimal).** Approval must come from the **invoking user or a configured
  approver** (the full authority matrix is Phase 2).
- **Capability-profile schema defined now, filled only for GitHub + Slack** (don't overbuild).
- **In-line channel (Slack).** `block_actions` envelopes on the Socket Mode listener; render the
  **exact artifact** + provenance; map Slack user → Marathon user + approver authz; deep link to hub.

**Phase 2 — Agent Hub (web UI).**
- A queue of outstanding proposals rendering the **exact artifact** (diff / message / mutation),
  **provenance** ("based on repo X / issue Y / thread Z"), cost, and risk axes, with approve /
  reject / **edit-then-approve** (editing changes the hash → re-approval). Real auth + RBAC +
  audit (`resolved_by_user_id`, who-saw-what). Also hosts the **inspectability dashboard** (M8
  carry-over) + cross-surface task status.
- Expiry/escalation (M5) surfaced in both channels.

Depends on: M5 (durable waits + idempotency), M6.1 (governed tools in the live run), M8 (data API
the hub renders), M2/§6.1 (Pi session suspend/resume).
**v1 success criterion (the one that matters):** a **prompt-injected model can *propose* a bad
effect but cannot *directly execute* it.** If that holds, the architecture is doing its job.

Exit criteria — unit tests + automated demo (+ live smoke):
- *Unit tests:* `propose_effect` schema validation; declarative router mapping (incl. the Slack
  audience predicate); **payload-hash binding + revalidation** (a mutated payload voids approval);
  **at-most-once execution** under a retry storm (idempotency_key); **reviewer authority**
  (unauthorized principal can't approve); suspend→resume resolves the same `ProposedEffect` once.
- *Automated demo* (`make demo-m10`): a (fake) run proposes a high-risk effect → task suspends →
  approve → executor runs it **exactly once** (re-fire the executor → no second effect); a second
  run → reject → never runs; a third → **edit the payload after approval** → execution rejected
  (hash mismatch / new version required); assert autonomous/native actions in the same run never
  prompted; assert an **injected model that tries to call an effect directly cannot** (only
  `propose_effect` exists).
- *Live smoke:* `@marathon …` that would merge/delete in Slack → proposal → Approve (or hub) →
  executor acts; reject/edit → it doesn't; a normal code change → **PR (no in-app approval)**.

> **Staging.** Phase 1 (propose/route/execute + Slack in-line) is the core; the **hub** (web app
> + auth) is Phase 2 and may split into its own milestone — both render/resolve the *same*
> `ProposedEffect`, so the seam is built once.

---

### M11 — Orchestrated agent loop (frontier plan/verify + sub-agents)

**Goal:** an invocation with a **verifiable goal** runs a **frontier-orchestrated loop** — the
meta-harness "loop" organ (design **§28.2**). A frontier "lead" model plans the work and
validates each iteration; cheaper sub-agents execute it under isolation + governance; the loop
runs to a verified outcome and reports back. (Folds in the **coordinator** organ — the lead
picks the sub-agents.) **Loop only where a verifier exists:** the plan must state an objective
verifier (tests/types/build/checkable criteria); tasks without one (summaries, investigations,
judgment calls) run as a **one-shot prompt** — a single agent turn, today's behavior.

Human prerequisites:
- None new (reuses model + surface + sandbox setup). Set the **reasoning-tier** model for the
  orchestrator and a budget cap per task.

Build (per §28.2):
- **Plan step** — a frontier orchestrator (reasoning tier, §7.19) turns goal + context (§7.18) +
  recalled memory (§7.12) into a **plan** (success criteria + objective verifier, iteration
  shape, chosen sub-agents/tools) and a **clean sub-agent prompt** (also the §12.2 sanitization
  point; the generated prompt lands in the sub-agent's *untrusted* context layer, §7.18). If no
  objective verifier can be stated, the plan returns **one-shot** and the task runs as a single
  turn.
- **Loop StepRunner** — iterate **execute → verify → {done | continue | escalate}**, each
  iteration a checkpointed `TaskStep` (§11.2) so it resumes mid-loop; sub-agents run via
  `AgentRuntime` in the **sandbox** (§12.6) under the **gateway** (§7.8).
- **Verification** — frontier judgment **plus objective checks where available** (tests/types/
  build as sandboxed tools). **Exit detection** (verifier done-signal) + **caps** (max
  iterations + spend budget, M8) + **grounding** (state in workspace/checkpoint/memory).
- **Escalation** → the durable human wait (M10 approval).
- **Report** — progress + a loop summary (iterations, cost) to the originating surface(s);
  write learnings to memory.

Depends on: M2 (runtime), M7 (memory + prompt assembly), M8 (budgets/timeline), M9 (sandbox),
M10 (escalation). Two model tiers via §7.19.
Exit criteria — unit tests + automated demo:
- *Unit tests:* loop control (done / continue-with-feedback / escalate / iteration-cap),
  checkpoint resume mid-loop, exit detection.
- *Automated demo* (`make demo-m11`, fakes): a goal needing 2 iterations — a fake frontier
  *verifier rejects* iteration 1 (continue with feedback) and *accepts* iteration 2 (done) — a
  fake sub-agent executes each; assert the loop converges, respects the cap, and reports.
- *Live smoke:* a real frontier-orchestrated loop (reasoning model plans + verifies, sub-agent
  executes a governed read) over a small real goal.

---

## 2b. Learned since build (new / re-prioritized work)

Surfaced while implementing M0–M6.2. These update the plan based on what the code taught us;
fold into M7–M9 sequencing as capacity allows.

1. **Live-Pi approval suspend/resume** *(scheduled M10 — then **redesigned away**,
   2026-07-01).* The approval engine exists at the orchestration layer; suspending an
   in-flight Pi turn was the gap. Superseded: `propose_effect` is an **async tool call**
   (returns `effect_id` + monitor immediately; queue-worked; the task waits **between turns**
   and resumes with the outcome — design §7.9, §11.6). The §6.1 spike (re-prompt vs. fork) is
   obsolete; M6.1's current "return 'approval required' to the model" behavior is roughly the
   right shape, and gains the monitor handle + continuation wiring in M10.
2. **Govern Pi's built-in tools** *(security; M9 — largely done).* `read/grep/find/ls` bypass
   the `ToolGateway`, so they are **off by default** (`PiAgentRuntime.builtinTools`). The live
   agent runs with only governed tools, and the **`sandbox` option now routes
   `bash`/`read`/`write`/`edit` into a hardened container** (Pattern 2) so they see only the
   workspace. Remaining: route `grep`/`find`/`ls` the same way (today the model uses `bash`).
3. **Execution isolation** *(M9 — landed).* `DockerSandbox` (one-shot) + persistent
   `DockerContainer` + the Pattern-2 tool routing isolate agent-run code (no network, no host
   creds, capability-stripped, resource-limited) against an ephemeral workspace; `NoSandbox`
   refuses by default. Remaining: microVM (Gondolin/Firecracker) backend, consistent uid mapping.
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
8. **Adapter breadth — a 2nd harness** *(meta-harness organ #1, §28 — **promoted to K7**,
   2026-07-02).* No longer just a replaceability proof: **Claude Code (headless)** is a
   product requirement — the harness is selectable one-or-the-other per deployment
   (design §7.5). Built as **K7** (§2c); the router (organ #2) choosing a harness per task
   remains future.
9. **Memory access model redesigned** *(security; supersedes the M7 as-built model — design
   §7.12, decided 2026-07-01; **implemented 2026-07-03**, migration Track 13 — pulled ahead
   of the post-kernel queue so no new kernel behavior builds on agent-scoped memory; the
   egress-source tie-in still queues with M10).* Scopes are audiences (**tenant / project / user / thread**);
   **agent scope retired** as an access boundary (now relevance metadata). Recall is
   **audience-gated** (task audience ⊆ scope audience; computed deterministically — repo
   audience natively on GitHub, Slack via an admin-declared channel↔project mapping +
   external-member flags; unknown → tenant-only, external present → none). Writes go to the
   narrowest scope, gated by breadth (tenant writes require confirmation); recalled scopes
   count as sources in the egress policy (§7.8). Refactor the M7 `MemoryStore`/
   `PgVectorMemoryStore` schema, feedback→memory writes (👎 corrections become **user-scoped**,
   promotable), and prompt-builder recall (pass the computed `TaskAudience`). Pairs with #10
   (identity linking) and OQ-4 (sensitivity metadata).
10. **Identity linking** *(OQ-1 resolved — design §7.20; unblocks on-behalf-of).* Build the
    Slack-initiated OAuth link: `/marathon link github` + a CTA on the §7.8 denial notice → a
    **single-use signed URL** (tenant, slack_user_id, nonce, expiry) → **GitHub App user
    authorization** (identity-only scope) → `UserIdentity` write with
    `verification_method: oauth`. Store the user-to-server token as the per-user **access
    checker** (ask GitHub *as the user*); a failed refresh marks the link `stale` → deny until
    re-linked. GitHub-surface users are auto-created keyed on the webhook-authenticated GitHub
    login. The hub **Identities** page lands with M10 Phase 2; IdP bulk-provisioning
    (`verification_method: idp`) when a tenant asks.

---

## 2c. Kernel milestones (K1–K7)

> The build order for the **core kernel loop** (design §0): Slack ask → design-doc PR →
> iterate → merge-as-approval → sandboxed code implementation → code PR, delivered back to
> the thread and the doc. These are **the only critical path** until the §0.6 bar is met
> (**Marathon codes Marathon**); M10, M11, §2b #9/#10, and the M9 remainder queue behind it.
> Same definition of done as the M-series: unit tests + an automated demo in CI, plus a live
> smoke where a real service matters. K1–K4 are hand-built (they *are* the loop's machinery);
> **K5 is the designated "first blood" change, built through the loop itself**; K6 makes it
> stranger-ready; **K7 adds the Claude Code harness** — parallelizable from K1 and **not
> required for the §0.6 bar** (first blood ships on the already-integrated harness).

### K1 — Code-writing path end-to-end (BUILD → DELIVER)
**Goal:** implement the **execution contract in design §29** — a merged design-doc plan
produces a **green-tested code PR**, entirely through governed + sandboxed machinery. The
contract is the spec; this milestone builds it.

Human prerequisites:
- GitHub App **write** scopes on the dogfood repo (in place since M5); confirm branch
  protection on `main` so the agent can only land work via PR.
- Approve a **pinned toolchain base image** (git + Node + pnpm) for the sandbox, so `bash`
  can run the target repo's test suite.
- Decide the initial **protected-path list** (default: `.github/workflows/**` refused —
  CI config runs with repo secrets) and the **diff-size caps** (§29.4).
- Docker available on the CI runner for the sandbox-backed demo (or the demo uses
  `FakeSandbox` with the image path covered by the live smoke).

Build (per design §29):
- **Trigger + input (§29.1/§29.1a):** the doc PR merges into the **plans branch** (the
  approval; the default branch is untouched) → implementation task with `plan_ref`
  **pinned to that merge commit**, `base_sha` **pinned to the default-branch head at
  approval** (the two are decoupled — different branches), and the
  `(repo, doc_path, merge_commit_sha, "implement")` idempotency key.
  *(2026-07-04 decision, §29.1a / Track 18.)*
- **Workspace lifecycle (§29.2):** host-side clone at `base_sha`, **the approved plan doc
  materialized at its doc path** (fetched at `plan_ref.merge_commit_sha`, so it is in the
  tree — no side-channel plan delivery — and rides the diff into the code PR),
  **remotes + credential helpers stripped** before mounting; teardown always destroys
  everything.
- **`github.submit_code_changes` (§29.4):** the single governed handoff tool — the model
  passes title/summary/plan-ref/verification only; **the gateway reads the diff from the
  workspace** (`git diff base_sha..worktree`, host-side), then: size caps, protected-path
  refusal, secret scan on added lines, `marathon/<task_id>-<slug>` branch, bot-authored
  commit with a `Marathon-Task:` trailer, `--force-with-lease` push with tenant App creds,
  create-or-update PR idempotent on `(task_id, tree_hash)`. All failures are **typed,
  agent-visible errors** so the agent corrects course in-session.
- **Verify (§29.3):** command sources in precedence order (repo `.marathon/config.yml`
  `verify:` → the plan's Verification section → agent judgment); green → ready PR; red at
  the iteration/spend cap → **draft PR + `marathon:unverified` + honest failure report**.
  (The harness's in-session loop is the verifier — no M11.)

Depends on: M9 Pattern-2 sandbox (landed), M6.1 governed tools, M6 merge webhook.
Exit criteria:
- *Unit tests:* workspace materialization (pinning, remote/credential stripping), the §29.4
  gateway algorithm (diff capture, size caps, **protected-path refusal**, secret scan,
  branch naming, `(task, tree_hash)` idempotency), plan-ref binding, draft-forcing on red
  verification.
- *Automated demo* (`make demo-k1`): a fake merged plan against a local fixture repo →
  sandboxed edits → verify runs → handoff → branch + PR on a fake/local git host. Assert:
  the sandbox env is credential-free; the trace has no secrets; a diff touching
  `.github/workflows/` is **refused**; a re-submit with the same tree is a **no-op**; a
  red-verify run yields a **draft** PR with the failure report.
- *Live smoke* (`make smoke-k1`): a real, small change on the sandbox repo lands as a green
  PR end-to-end, with the plan link and verification results in the PR body (§29.5).

### K2 — Loop task chain + delivery targets
**Goal:** the loop's tasks form one chain, and progress/results are delivered to **both** the
originating Slack thread and the doc PR (design §29.1, §29.6).

Human prerequisites: none new.
Build:
- Persist `delivery_targets` on `Task` (§10.8); the doc-draft task records its originating
  thread; the merge-spawned execution task **inherits** `[Slack thread, doc PR]`.
- Surface delivery fan-out to multiple targets (post-once-per-target, idempotent per §11.3).
- The final result (PR link + summary) and milestone progress land on both; the ack in each
  place links the other.

Depends on: M6 (merge→execute), M5.5/M6.2 (live delivery paths).
Exit criteria:
- *Unit tests:* target inheritance across the chain, multi-target fan-out idempotency.
- *Automated demo* (`make demo-k2`): simulated full chain with fake Slack + GitHub → assert
  both fakes received progress and the final PR link exactly once.

### K3 — Iteration continuity (ITERATE), verified against the loop
**Goal:** doc-PR comments revise the draft; thread replies continue the conversation;
clarifying questions get asked, answered, and incorporated.

Human prerequisites: none new.
Build (mostly verification + gap-fixing of built pieces):
- Thread reply → follow-up task with thread context + thread memory (M7) — exercised against
  this loop specifically.
- Clarifying-question pattern: ask in-thread, end the turn (§11.6 async shape); the user's
  reply spawns the continuation with full context.
- Doc-PR comment → `document.revise` on the draft branch (built in M7) — regression-proofed,
  including a comment arriving **while** another loop task runs (parallel tasks, §7.4).
- **Code-PR revisions (§29.6):** an `@marathon` comment on the *code* PR spawns a revision
  task pinned to the task branch's tip, handing off through the same `submit_code_changes`
  onto the **same branch and PR**.

Depends on: M7 (memory + revision loop), K2 (chain context).
Exit criteria:
- *Unit tests:* thread-continuation context assembly, revise-vs-new-PR routing.
- *Automated demo* (`make demo-k3`): a scripted multi-round conversation fixture — draft →
  comment → revision → question → answer → updated draft — asserting each round builds on
  the last.
- *Live smoke:* one real multi-round doc iteration on the sandbox repo.

### K4 — Durable resume of a real run (§2b #4)
**Goal:** a worker crash mid-BUILD resumes from the per-turn checkpoint — no restart, no
double effects. Long code-writing stages make this kernel, and it's the demo-kernel kill test.

Human prerequisites: none new.
Build:
- Multi-turn tool loop in `PiAgentRuntime` with **per-turn session persistence** (today the
  real path is single-turn; only fakes exercise resume).
- On resume: re-open the session, **re-provision the sandbox + re-materialize the workspace**
  (same pinned SHA + replay the checkpointed workspace diff), continue the turn sequence.
- Idempotency on re-executed tool calls (existing keys; verify under resume).
- **Turn atomicity (design §11.2 BUILD-stage contract):** a crash mid-turn **discards the
  incomplete turn and replays** from the last completed checkpoint; **containers are never
  recovered** (always re-provision + re-materialize); interrupted test runs rerun and count
  for nothing until complete; the handoff converges via `(task_id, tree_hash)`.

Depends on: K1 (the real run to resume), M1 (checkpoint spine).
Exit criteria:
- *Unit tests:* per-turn checkpoint serialize/restore, workspace diff snapshot/replay.
- *Automated demo* (`make demo-k4`): kill the worker mid multi-turn run → a fresh worker
  resumes and completes; effects asserted at-most-once.
- *Live smoke:* kill during a real code task; the PR still lands, once.

### K5 — Status + cost visibility — **the first-blood change, built via the loop**
**Goal:** `@marathon status` replies in-thread with the §15.3 view (current step, completed
steps, waiting state); final results carry the silent cost footer (§13.3).

**Build method (ratchet #1):** once K1–K4 land, this change is **asked for in Slack and built
by Marathon through its own loop** — doc PR, review, merge, implementation, code PR. Every
stumble is a kernel bug to file and fix; hand-finish only if the loop falls short, recording
exactly where it fell short.

Depends on: K1–K4; M8 (timeline + cost rollups — the data already exists).
Exit criteria:
- *Unit tests + automated demo* (`make demo-k5`): status command → rendered state for
  running / waiting / completed tasks; cost footer on the final result.
- *Meta-exit:* the change **merged to `main` via the loop** — or a written list of the loop
  failures that prevented it (which becomes the next work list).

### K6 — Quickstart + flagship agent (stranger-ready)
**Goal:** `git clone → docker compose up → YAML agent → Slack app + GitHub App → first loop`
on a stranger's own repo in **under ~30 minutes** (ratchet #3).

Human prerequisites:
- A fresh test machine/account for the timed walkthrough; a reviewer who has never set
  Marathon up.

Build:
- **One flagship agent** — **Forge**, defined in design §21.0 (YAML persona spanning the
  whole loop: drafts design docs *and* writes code; grants enforced by construction;
  conservative per §7.3).
- Setup docs: Slack app manifest, GitHub App creation walkthrough, `.env` template; compose
  profile that builds/pulls the sandbox toolchain image.
- **`make demo-kernel`** — the full scripted CI umbrella (ask → doc PR → comment → revision →
  question → merge → sandboxed build with tests → code PR → links in both places → mid-BUILD
  kill + resume), built from the K1–K5 demos.
- README rewritten around the loop (§0.1 is the pitch).

Depends on: K1–K5.
Exit criteria:
- *Automated demo:* `make demo-kernel` green in CI.
- *Human test:* the timed fresh-machine walkthrough completes the first loop in ≤ 30 minutes
  without help.

### K7 — Claude Code harness (headless) behind `AgentRuntime`
**Goal:** Marathon runs with **either harness** — `harness: pi | claude-code`, selected per
deployment with a per-agent override (design §7.5) — with identical governance, durability,
and delivery. Same gateway chokepoint, same session-JSONL checkpoint, same between-turn
resume. **Non-blocking:** this milestone does not gate the §0.6 bar — sequence it alongside
or after first blood.

Human prerequisites:
- An **Anthropic API key** (billing + spend cap) in the secret store.
- Approve adding the `claude` CLI to the **pinned sandbox toolchain image** (K1's image).
- Approve the sandbox **egress-allowlist entry** for the host-side model proxy (the only
  network exit besides the broker).

Build:
- **`ClaudeCodeAgentRuntime`:** spawn `claude -p --output-format stream-json` **inside the
  sandbox** (Pattern 1, §12.6); parse the event stream onto `TaskStep`s / progress; capture
  cost + usage from the result event into `ModelInvocation`.
- **Governed tools over MCP:** an MCP server backed by `gateway.run`, served over the host
  broker socket — same validate → ledger → egress-route → inject → execute → redact → audit
  path as Pi's custom tools. Constrain built-ins via the harness allow/deny tool lists;
  file/bash tools are contained by construction (the process lives in the container, seeing
  only the workspace).
- **Model proxy:** host-side key-injecting proxy (`ANTHROPIC_BASE_URL`); per-tenant Anthropic
  keys stay host-side; no key material in the container image, FS, or env.
- **Checkpoint/resume:** persist the Claude Code session JSONL + session id per task;
  between-turn resume via `--resume <id>` (the same async-proposal shape, §11.6).
- **Config:** deployment default + per-agent `harness:` override in the agent YAML (§6.2).

Depends on: K1 (the code path it must reproduce), M9 broker (built). Can proceed **in
parallel** with K2–K4.
Exit criteria:
- *Unit tests:* stream-json event parsing → TaskStep mapping; MCP↔gateway bridging (audit,
  redaction, egress routing preserved); proxy key injection (assert **no key in the container
  env**); session-id checkpoint/resume mapping.
- *Automated demo* (`make demo-k7`): a recorded/fake Claude Code run drives the same task
  pipeline green — threaded reply, tool calls audited, cost captured.
- *Live smoke + the real bar:* **re-run the K1–K4 demos and `make demo-kernel` green with
  `harness=claude-code`** — the loop works identically on either harness, which is what
  "harnesses are replaceable" (§28 organ #1) means in practice.

---

## 3. Dependency / critical path

```
M0 ─► … ─► M5 ─► M5.5 ─► M6 ─► M6.1 ─► M6.2 ─► M7 ─► M8   ✅ done & CI-green
                                                  │        (M9 core + Pattern-2 sandbox landed — feeds K1)
                                                  ▼
        K1 ─► K2 ─► K3 ─► K4 ─► K5 ─► K6                   ← the kernel (§2c) is the whole critical path
     (code PR) (chain) (iterate) (resume) (first blood,   (stranger-
        │                                  via the loop)    ready)
        └────► K7 (Claude Code harness — parallel from K1; re-proves K1–K4 + demo-kernel
                   under harness=claude-code)
                                                  │
                                                  ▼  after the §0.6 bar (Marathon codes Marathon)
        M10 (async proposals + Agent Hub) · M11 (orchestrated loop) ·
        §2b #9 (memory refactor) · §2b #10 (identity linking) · M9 remainder (microVM, uid)
```

The **kernel (§2c) is the only critical path** until the §0.6 bar is met. K1→K2 can overlap
K3 (different subsystems); K4 needs K1's real run; **K5 is built through the loop itself**
(ratchet #1); K6 closes with the stranger test; **K7** (the Claude Code harness) runs in
parallel from K1 and completes by re-proving K1–K4 and `demo-kernel` under
`harness=claude-code` — it does **not** gate the bar; the fastest path to first blood is the
already-integrated harness (Pi). Everything below the bar line keeps its
design (see `design/` + `policy.md`) and queues: M10's async-proposal wiring becomes relevant
when a high-risk connector is first enabled; M11 when tasks outgrow one Pi session; §2b #9/#10
with restricted-tier tenants (OQ-4's reopen trigger).

---

## 4. Cross-cutting, built in from the start

- **Idempotency — at-least-once delivery, at-most-once effects** — established in M1,
  honored by every write tool (M5), document edit (M6), and proposed effect (M10).
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

## 5. Out of scope for MVP (historical — the current scope lens is the kernel, design §0)

User-initiated cancellation · multi-tenant enterprise mgmt / SSO / advanced RBAC ·
external agent/connector/SDK builder experience · document providers beyond GitHub
markdown (Google Docs, Notion — on request) · per-agent Slack identities · advanced
(cost/quality) model routing · scheduled/recurring tasks · full vector knowledge base.

---

## 6. Key risks & open questions

1. **Pi durable approval wait — RESOLVED BY REDESIGN (2026-07-01).** The durable approval
   *engine* is built and tested at the orchestration layer (M5). The formerly-open half —
   suspending an in-flight **Pi** turn — is designed away: `propose_effect` is an **async
   tool call** returning immediately with `effect_id` + a monitor handle; waits happen
   **between turns** at the task level, and the session resumes with the outcome as the next
   turn's input (design §7.9, §11.6). The re-entry spike (re-prompt vs. fork) is obsolete.
   Remaining M10 work: the `get_effect_status` tool, the continuation wiring, and the
   executor.
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
