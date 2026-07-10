# Marathon Design Guide

Marathon is an open-source platform for **durable AI agents that work where teams already
work** — Slack and GitHub-backed markdown documents — built on a replaceable agent harness
(**Pi** today; **Claude Code headless** with K7) behind the `AgentRuntime` seam.
Agents are summoned by `@mention`, run as durable background tasks, use governed tools, act
autonomously for reversible, audience-bounded work — while high-risk effects go through
**propose → review → execute** (§7.9) — and report back in-thread or as document
comments / pull requests.

This guide is the canonical product + architecture design. It was split from a single
`design.md` into this directory (an Obsidian vault); each numbered section is its own note.
The build-ordered implementation plan is in [`roadmap.md`](../roadmap.md); the architecture
diagram is in [`diagram.md`](../diagram.md); the harness integration references are in
[`pi-details.md`](../pi-details.md) (Pi) and [`claude-code-impl.md`](../claude-code-impl.md)
(Claude Code headless — roadmap K7).

> **Reading order.** New here? Start with **[[00-core-kernel]]** — the prioritization lens
> over everything else: the one loop that must work correctly for the first customers, what
> ships minimal, and what is deferred. Then [[01-product-summary]], [[05-product-principles]],
> and [[06-core-user-journeys]] for the *what/why*, and [[09-reference-architecture]] and
> [[07-functional-requirements]] for the *how*. Implementers should pair this with
> [`roadmap.md`](../roadmap.md).
>
> Section cross-references in the text use the original `§N.M` numbering, which maps 1:1 to
> the files below (e.g. `§7.18` → [[07-functional-requirements]], the "Prompt & context
> assembly" subsection). Where a section notes *as-built* status, it reflects what the code
> actually does today vs. the original design.

## Product & users

- [[00-core-kernel]] — **the loop that must work** (ask → draft doc PR → iterate → build code
  → deliver PR); kernel vs. minimal vs. deferred, and the kernel gap list (K1–K7).
- [[01-product-summary]] — what Marathon is, in one section.
- [[02-product-goals]] — the primary goals the product must hit.
- [[03-non-goals]] — explicitly out of scope for the initial product.
- [[04-target-users]] — Slack end user, tenant admin, agent developer, agent owner.
- [[05-product-principles]] — the seven principles (meet users where they work, durable by
  default, secure by construction, approval for risk, inspectability, cost-aware, extensible).
- [[06-core-user-journeys]] — install → create agent → invoke → feedback → approval → retry →
  document tagging → document-driven execution.

## Functional & non-functional requirements

- [[07-functional-requirements]] — surfaces, registry/discovery, task lifecycle, harness,
  feedback, tools + permissioning, approval, model routing, cost, memory, admin/CLI/SDK,
  surface abstraction, document surface, **prompt & context assembly (§7.18)**, **model
  selection (§7.19)**, **identity linking (§7.20)**.
- [[08-non-functional-requirements]] — reliability, security, scalability, latency,
  observability, portability, extensibility, compliance.
- [[33-stage-specific-agent-instructions]] — optional, versioned instruction blocks for the
  current draft, design-review, build, or code-review stage.

## Architecture & data

- [[09-reference-architecture]] — high-level architecture and core services.
- [[10-data-model]] — entities: Tenant, User/Identity, Agent/AgentVersion, Task/TaskStep,
  Model/Tool invocations, ApprovalRequest, ProposedEffect, Feedback, AuditEvent,
  DocumentArtifact, …
- [[11-task-execution-model]] — state machine, checkpointing, idempotency, retries,
  dead-letter, durable human waits.

## Cross-cutting concerns

- [[12-security-design]] — trust boundaries, prompt-injection defenses, **exfiltration /
  confused-deputy (§12.2)**, secrets, authorization, retention, **execution isolation (§12.6)**.
  The trust-model decision (capability-first + **Proposed Effects**) is in
  [`policy.md`](../policy.md).
- [[13-model-and-cost-design]] — model abstraction, routing strategies, cost controls.
- [[14-connector-design]] — connector interface, GitHub / database / Slack / document
  connectors, built-in vs MCP tool sources.
- [[30-trust-profiles]] — one security model from solo dev to company: the invariant floor,
  the profile ladder (`solo`/`team`/`org`/`hosted`), ratchet semantics, and the
  trigger-sequenced plan.

## Experience & operations

- [[15-surface-ux-design]] — agent tone, progress, status, cancellation, final-answer format,
  document UX.
- [[16-admin-ui-design]] — navigation, agent / task / connector pages, cost dashboard.
- [[17-evaluation-design]] — eval sources, case structure, eval types, release process.
- [[18-open-source-project-design]] — repo structure, default stack, licensing, contribution.

## Scope, plan & appendices

- ~~19-mvp-scope~~ — **deleted (2026-07-02)**: superseded by [[00-core-kernel]], which is the
  scope lens now (kernel vs. minimal vs. deferred). The old MVP (roadmap M0–M6) is recorded
  as history in the roadmap's status notes.
- [[20-roadmap]] — pointer to the build-ordered [`roadmap.md`](../roadmap.md).
- [[21-example-agents]] — Bruce, Ada, Grace, Linus, Quill.
- [[22-design-tradeoffs]] — the key decisions and why (one bot vs many, service account vs
  impersonation, queue vs workflow engine, built-in vs MCP, trace logging vs privacy).
- [[23-metrics]] — product, quality, cost, reliability metrics.
- [[24-risks-and-mitigations]] — the main product/engineering risks.
- [[25-recommended-first-implementation]] — what to build first + the first demo scenario.
- [[26-marathon-positioning]] — how Marathon relates to adjacent tools.
- [[27-final-design-recommendation]] — the durable agent task, restated.
- [[28-meta-harness-organ-map]] — Marathon as a Layer-2 meta-harness: the seven organs →
  components, and the **frontier-orchestrated loop** (plan → execute → verify → repeat).
- [[29-code-handoff]] — the **BUILD → DELIVER execution contract** (the kernel's central
  path): plan merge → pinned workspace → verify → `submit_code_changes` (gateway reads the
  diff from the workspace) → branch → code PR → delivery + revisions.
- [[open-questions]] — tracker for acknowledged-but-unsettled design questions (identity
  linking, suspend/resume spike, memory write gating, …).
