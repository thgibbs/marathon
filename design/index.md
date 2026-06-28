# Marathon Design Guide

Marathon is an open-source platform for **durable AI agents that work where teams already
work** — Slack and GitHub-backed markdown documents — built on the **Pi** agent harness.
Agents are summoned by `@mention`, run as durable background tasks, use governed tools, ask
for human approval before destructive actions, and report back in-thread or as document
comments / pull requests.

This guide is the canonical product + architecture design. It was split from a single
`design.md` into this directory (an Obsidian vault); each numbered section is its own note.
The build-ordered implementation plan is in [`roadmap.md`](../roadmap.md); the architecture
diagram is in [`diagram.md`](../diagram.md); the Pi harness reference is in
[`pi-details.md`](../pi-details.md).

> **Reading order.** New here? Start with [[01-product-summary]], [[05-product-principles]],
> and [[06-core-user-journeys]] for the *what/why*, then [[09-reference-architecture]] and
> [[07-functional-requirements]] for the *how*. Implementers should pair this with
> [`roadmap.md`](../roadmap.md).
>
> Section cross-references in the text use the original `§N.M` numbering, which maps 1:1 to
> the files below (e.g. `§7.18` → [[07-functional-requirements]], the "Prompt & context
> assembly" subsection). Where a section notes *as-built* status, it reflects what the code
> actually does today vs. the original design.

## Product & users

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
  selection (§7.19)**.
- [[08-non-functional-requirements]] — reliability, security, scalability, latency,
  observability, portability, extensibility, compliance.

## Architecture & data

- [[09-reference-architecture]] — high-level architecture and core services.
- [[10-data-model]] — entities: Tenant, User/Identity, Agent/AgentVersion, Task/TaskStep,
  Model/Tool invocations, ApprovalRequest, Feedback, AuditEvent, DocumentArtifact, …
- [[11-task-execution-model]] — state machine, checkpointing, idempotency, retries,
  dead-letter, durable human waits.

## Cross-cutting concerns

- [[12-security-design]] — trust boundaries, prompt-injection defenses, secrets,
  authorization, retention, **execution isolation (§12.6)**.
- [[13-model-and-cost-design]] — model abstraction, routing strategies, cost controls.
- [[14-connector-design]] — connector interface, GitHub / database / Slack / document
  connectors, built-in vs MCP tool sources.

## Experience & operations

- [[15-surface-ux-design]] — agent tone, progress, status, cancellation, final-answer format,
  document UX.
- [[16-admin-ui-design]] — navigation, agent / task / connector pages, cost dashboard.
- [[17-evaluation-design]] — eval sources, case structure, eval types, release process.
- [[18-open-source-project-design]] — repo structure, default stack, licensing, contribution.

## Scope, plan & appendices

- [[19-mvp-scope]] — MVP promise, requirements, and explicit cuts.
- [[20-roadmap]] — pointer to the build-ordered [`roadmap.md`](../roadmap.md).
- [[21-example-agents]] — Bruce, Ada, Grace, Linus, Quill.
- [[22-design-tradeoffs]] — the key decisions and why (one bot vs many, service account vs
  impersonation, queue vs workflow engine, built-in vs MCP, trace logging vs privacy).
- [[23-metrics]] — product, quality, cost, reliability metrics.
- [[24-risks-and-mitigations]] — the main product/engineering risks.
- [[25-recommended-first-implementation]] — what to build first + the first demo scenario.
- [[26-marathon-positioning]] — how Marathon relates to adjacent tools.
- [[27-final-design-recommendation]] — the durable agent task, restated.
