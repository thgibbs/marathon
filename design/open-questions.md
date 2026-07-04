# Open design questions

Tracker for design questions that are **acknowledged but not yet settled**. Each entry states
the question, why it matters, the current stance (what the system does today / fails to), and
where it's referenced. When a question is settled, write the decision into the relevant design
section and record a one-line resolution here (don't delete the entry — the history is
useful). Critique context: [[fable]].

---

## OQ-1 — Cross-surface identity linking

> **Resolved 2026-07-01 (design; implementation = roadmap §2b #10).** **Identities are
> proven, never typed** — OAuth-proven linking initiated from the authenticated surface
> (design **§7.20**): the Slack identity is proven by the signed interaction that mints a
> single-use link URL; the GitHub identity by GitHub App OAuth (identity-only scope). Entry
> points: `/marathon link github` and a CTA on the §7.8 denial notice. The user-to-server
> token doubles as the **access checker** (ask GitHub *as the user*) and its refresh as
> **liveness** (failed → `stale` → deny until re-linked). Provenance tiers
> `oauth | idp | admin_asserted`; tenant policy sets the tier on-behalf-of requires (`oauth`
> default). Schema in §10.2; credential mode in §12.3; hub Identities page in M10 Phase 2.

**Question.** How does a Slack user prove they are a given GitHub user — and generally, how is
*surface identity ↔ Marathon user ↔ connector identity* established? What is the flow (OAuth
link? admin mapping? verification challenge?), where is it stored (§10.2 `UserIdentity` can
hold it), how is spoofing prevented, and what is the UX when the link is missing?

**Why it matters.** This is now a **hard prerequisite** for the default egress policy:
`on-behalf-of` (§7.8) verifies the requestor's access to each sensitive source, and an
unlinked identity is **denied** — so without a linking flow, the platform degrades to
deny-everywhere for any task touching a sensitive source. Reviewer authority for Proposed
Effects (§7.9) and cross-surface progress (roadmap M8 carry-over) also depend on it.

**Current stance.** Unlinked/indeterminable → denied with a platform-generated "link your
identity" notice. No linking flow designed or built. For *audience* computation, the
admin-declared channel↔project mapping (§7.12) is a pragmatic bridge — but per-user access
checks for on-behalf-of document reads still require the link.

**Refs.** §7.8, §10.2, `policy.md` §11.7, [[fable]] M7.

---

## OQ-2 — Pi suspend/resume re-entry mechanism

> **Resolved 2026-07-01 (redesign).** Superseded by the **async-proposal** model:
> `propose_effect` returns immediately with `effect_id` + a `get_effect_status` monitor; the
> proposal is worked on a durable queue; the agent polls, does other work, or ends its turn,
> and the task resumes **between turns** with the outcome appended as the next turn's input —
> the resume path Pi supports natively. The mid-call suspend/fork question is retired, and the
> executor-performs-the-approved-artifact rule removes the regenerate/hash-mismatch livelock.
> Remaining small questions: `get_effect_status` shape (poll vs. push into the session),
> orchestrator heuristics for end-turn-and-wait vs. in-turn polling, and Pi version pinning
> for long-suspended sessions (folded into OQ-6). Encoded in §7.9, §11.6; roadmap M10 / §6.1
> updated.

**Question.** When a suspended task resumes after a human decision: re-prompt-to-continue or
fork-before-the-blocked-call? The *semantics* are now settled (§11.6 — the non-model executor
performs the exact approved artifact; the resumed model never re-executes it, which avoids the
propose→regenerate→hash-mismatch livelock), but the session re-entry mechanism has never been
spiked, and a session suspended for days may be re-opened by an upgraded Pi (format/version
pinning — see OQ-6).

**Why it matters.** Every human-in-the-loop flow stacks on this: Proposed Effects (M10),
`waiting_for_input` clarifications (§7.4 — which have no design beyond the state name), the
document review wait (§6.8), and the M11 loop's *escalate* verdict.

**Current stance.** Approval engine works at the orchestration layer; M6.1 just returns
"approval required" to the model. Spike unrun (roadmap §6.1, risk #1 — "the headline gap").

**Refs.** §11.6, roadmap §6.1 / §2b #1, `pi-details.md` §6.3, [[fable]] C4.

---

## OQ-3 — Feedback→memory write gating

> **Resolved 2026-07-01; implemented 2026-07-03 (migration Track 13).** Memory scopes are audiences —
> tenant / project / user / thread — with **agent retired as an access scope** (relevance
> metadata only). Recall is **audience-gated** (task audience ⊆ scope audience); writes go to
> the narrowest scope with gating by breadth (user: none; project: light; tenant: confirmed),
> which also bounds poisoning blast radius; recalled scopes count as egress sources (§7.8).
> Adopted defaults, revisitable: user `preference` items recallable wherever the user is the
> requestor; tenant-scope recall allowed for proposal-gated external drafts. Encoded in §7.6,
> §7.8, §7.12, §9.2, §10.18, §12.2. **The stores now enforce this model** (audience-gated
> recall, user-scoped corrections with gated promotion, migration 0009 retiring the agent
> scope); the egress-source tie-in and Slack channel↔project mapping remain open (M10 /
> roadmap §2b #9 remainder).

**Question.** Who may write long-term memory? Should a 👎-plus-text correction require
confirmation (agent owner / invoking user) before promotion to long-term? Should recall filter
items by the sensitivity of what the *writing* task had read (agent/tenant-scoped memory is
not repo-gated today)? Do corrections need TTL/decay or review at agent-version publish?

**Why it matters.** Shipped attack surface (M7): today anyone who can react in a channel can
write an agent-scoped, long-term `correction` that steers every future task of that agent,
tenant-wide, indefinitely — a persistent injection channel — and memory recall can carry
private-project context across projects (a second exfiltration path).

**Current stance.** Corrections written directly to long-term memory; recall unions all
scopes; only *project*-scoped memory is permission-gated.

**Refs.** §7.6, §7.12, [[fable]] C3.

---

## OQ-4 — Read-side sensitivity metadata (feeds the egress policy)

> **Resolved 2026-07-01 (initial calibration).** **All repos are `company-viewable`** until a
> customer needs finer tiers — repo-derived content flows to any internal audience in every
> egress mode; tenant-external egress stays proposal-gated; Slack keeps its existing read
> rule (private channels aren't read without authorization — §14.4). Consequence: the
> on-behalf-of access check trivially passes for internal audiences at first, so identity
> linking (§7.20, roadmap §2b #10) is load-bearing initially for **reviewer authority**, and
> for egress only once restricted tiers exist. Reopen: the first customer with repos that
> must be restricted — fill `source_sensitivity` values + per-repo tenant overrides then.
> Encoded in §7.8 and `policy.md` §11.7.

**Question.** Fill the capability profiles' read-side fields per connector
(`source_sensitivity`, `read_scope_granularity`) and define the resource-visibility tiers
(public / company-viewable / restricted repo; public / private channel). Who sets tenant
overrides (e.g. "this repo is company-viewable"), and where do they live?

**Why it matters.** These are the static inputs the egress policy (§7.8) evaluates; until
they're filled for GitHub and Slack, on-behalf-of has nothing deterministic to check against.

**Current stance.** Schema defined (`policy.md` §11.5); values unfilled.

**Refs.** §7.8, §14.1, `policy.md` §11.5.

---

## OQ-5 — Task state machine gaps and concurrency

> **Resolved 2026-07-01 (design).** (a) **`expired` is the clear terminal state** for lapsed
> waits and overall deadlines (§11.1, §11.6); `blocked` is retired (`retrying` + the waiting
> states cover it). (b) `waiting_for_input` got its design via the async model — ask, end the
> turn, resume with the answer (OQ-2, §11.6). (c) **Concurrency** (§7.4): one message → one
> task (first mention resolves the agent); separate messages in a thread → **parallel** tasks,
> each seeing the thread (and each other) as context; an agent needing another's result
> monitors `get_task_status` or ends its turn — no platform-level serialization; writes stay
> safe via idempotency + base-SHA (§11.3). (d) `delivery_targets` defined minimally (§10.8).
> All deliberately lightweight — expected to evolve with usage.

**Question.** (a) `blocked` and `expired` appear in §7.4's state list but not §11.1's machine
— define their transitions, and which terminal state an expired wait lands in. (b) The
`waiting_for_input` clarification flow has no design (how user input maps back to a suspended
task — pairs with OQ-2). (c) Concurrency policy: two mentions in one thread, or a mention
while a task is already running there — serialize per thread, run parallel, or queue?
(d) `Task.delivery_targets` (§10.8) is named but unspecified.

**Why it matters.** These are the edges real Slack usage hits in week one.

**Refs.** §7.4, §10.8, §11.1, [[fable]] M1.

---

## OQ-6 — Retention vs. the Pi session checkpoint

> **Punted 2026-07-01 (deliberate).** No users yet, so no retention obligations and no
> upgrade path to preserve — revisit when either exists. Trigger conditions to reopen: the
> first real tenant with a retention/erasure requirement, or the first Pi upgrade with
> suspended sessions in flight. Until then: sessions are kept indefinitely and Pi is upgraded
> freely.

**Question.** The Pi session JSONL is simultaneously the durable checkpoint (resume depends on
it — waits can last days), the full trace (inspectability/replay), and a record of every
prompt and tool output (the data classes §12.5 makes deletable). When does the retention clock
start; can prompts/outputs be redacted from a session without breaking resume; and how is the
Pi session format versioned so a weeks-old suspended session survives a Pi upgrade?

**Why it matters.** Retention/erasure (§8.8, §12.5) and durability/audit (§7.5, §11.6)
currently make contradictory promises about the same artifact.

**Refs.** §7.5, §11.6, §12.5, [[fable]] M4.

---

## OQ-8 — Evaluation design (intentionally TBD)

> **Punted 2026-07-01 (deliberate).** To be designed **with users** — an eval system built
> before there's a feedback corpus would be guessing at what needs grading. §17 stays as
> directional scaffolding. Reopen when there are real users producing feedback worth
> promoting into cases.

**Question.** How does a recorded task become a *replayable* fixture when tool results and
memory recall are live? Who writes graders, and what is the LLM-grader rubric? Do evals gate
releases (§17.4 describes a process no milestone builds)? How do eval results connect to the
§23 metrics?

**Why it matters.** "Feedback-driven improvement" is a top-line goal (§2.6) and the
feedback→eval loop is a positioning differentiator (§26 #8) — the claim currently outruns the
design.

**Refs.** §17, §2.6, §26, [[fable]] M10.

---

## OQ-7 — Which task classes get the M11 orchestrated loop

> **Resolved 2026-07-01.** **Goal + verifier where possible; otherwise one-shot.** The plan
> step must state an objective verifier (tests, type-checks, build, checkable acceptance
> criteria); if it can't, the task runs as a **one-shot prompt** — a single agent turn, no
> loop — since iterating on self-graded prose buys cost and latency, not quality. Code-shaped
> work loops; summaries/investigations/judgment calls don't. Also encoded: the lead's
> generated sub-agent prompt is derived from untrusted content, so it enters the sub-agent's
> *untrusted* context layer (§7.18), never the instructions layer. Encoded in §28.2 and
> roadmap M11.

**Question.** The plan→execute→verify loop (§28.2) leans on objective checks (tests, types,
build) that exist only for code-shaped work. For investigations, summaries, and document
drafting — Marathon's flagship tasks — what is the verify step concretely, and is the loop
worth its cost there, or do those task classes stay single-turn? Also: the "clean sub-agent
prompt" is *derived from untrusted content by a model* — it must land in the untrusted layer
of the sub-agent's prompt (§7.18), not the instructions layer.

**Why it matters.** M11's cost/benefit is justified by an analogy (tight code feedback loops)
whose precondition most Marathon tasks don't meet.

**Refs.** §28.2, roadmap M11, [[fable]] M6.
