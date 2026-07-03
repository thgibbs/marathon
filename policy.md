# Marathon security & trust model — a design question for review

**Status:** open design question. This document is written to be handed to reviewers
(including other LLMs) with no access to the codebase. It states the problem, the current
design, a proposed simplification, the options, and the tradeoffs. Please argue for or
against — especially push back on the direction the author currently favors (Option B).

---

## 1. Context (what you need to know)

**Marathon** is an open-source platform for durable AI agents that work where teams already
work — Slack and GitHub-backed markdown documents. An agent is summoned by `@mention`, runs
as a durable background task, does work (reads/writes code, comments, opens PRs, edits docs),
and reports back. It is built on the **Pi** agent harness (an in-process coding-agent SDK)
and is intended to be **multi-tenant** and **self-hostable**.

Two kinds of things an agent does:

- **Code execution** — running shell commands, reading/writing files, running tests. Today
  this is isolated in a **hardened Docker container** (Pattern 2): the Pi harness and the
  model call stay on the *host*; the agent's `bash`/`read`/`write`/`edit` tools execute
  *inside* a container with **no network, no host credentials, an ephemeral workspace, dropped
  capabilities, and resource limits**. The container is the isolation boundary.
- **External effects** — acting on outside systems (GitHub: read files, comment, open issues,
  open PRs, push commits, merge, delete; documents: edit; etc.). These are "credentialed
  tools": they need a secret (e.g. a GitHub token) to act.

The question in this document is **only about external effects** — how we decide what an agent
is allowed to do to the outside world. (Code-execution isolation via the sandbox is settled and
not in dispute.)

---

## 2. The current design ("policy + approval")

External-effect tools run host-side behind a **Tool Gateway**, a single chokepoint that does:

```
validate input → check policy (is this tool granted?) → inject credentials
              → execute → redact secrets from output → record audit event
```

Plus an **approval engine**: each tool is flagged `destructive: true|false`. A call to a
destructive tool is *blocked* and raises an **approval request** that a human must satisfy
(the task suspends and resumes on approval). Non-destructive tools (comment, open issue, open
PR, undoable doc edit) run **autonomously** — the product philosophy is that only
destructive/irreversible actions require a human.

So there are effectively **three** overlapping mechanisms guarding external effects:

1. **The credential** the agent holds (a GitHub token, etc.).
2. **A policy** (per-tenant/agent grants: which tools may be called at all).
3. **An approval gate** (destructive calls need a human).

---

## 3. The proposed simplification ("capability by construction")

The claim: **three mechanisms is too many, and the policy/approval layers are the weakest of
the three.** A runtime policy check is just code that can have a bug or be circumvented by a
cleverly prompt-injected model. A **credential scope** cannot: a read-only token *cannot*
delete a repo, no matter what the model is tricked into trying.

The proposed model has **two boundaries, each doing exactly one job**:

- **The sandbox** is the boundary for **code**. Whatever filesystem/network is mounted into
  the container is, by definition, what the agent may touch. No per-command policy.
- **Scoped credentials** are the boundary for **effects**. The agent holds a least-privilege
  key whose scope defines what it can do. If it should not be able to merge to `main`, it is
  simply **not granted that capability** — rather than granted it and then gated by approval.

Enforcement of "what is destructive" moves **out of Marathon** and onto:

- **The credential's scope** (e.g. a fine-grained, read-mostly GitHub token), and
- **The resource's own permission system** (e.g. GitHub **branch protection** rules and repo
  role) — because that is the system that actually owns the resource.

The Tool Gateway collapses from a *policy brain* to thin *plumbing*: inject the correct
scoped credential → execute → redact output → audit. The `destructive` flag becomes
**documentation** ("don't hand this tool a token that can do it"), not a runtime branch. The
approval engine shrinks to an optional escape hatch — or disappears, because the natural
"approval" for an irreversible action is **"the agent opens a PR and a human clicks merge in
GitHub's own UI"**: the PR *is* the handoff, in the native tool.

---

## 4. The core decision

> Is there **any** action we want the agent to be *able* to do, but only *with a human's
> blessing inside Marathon itself* (as opposed to "leave it as a PR for a human to complete in
> the native tool")?

- **If no** → delete the policy/approval layer; rely on scoped credentials + resource-side
  permissions + a host-side budget cap. The in-Marathon approval engine largely evaporates.
- **If yes, a few** → keep one narrow approval path for exactly those actions; everything else
  is capability-scoped.

---

## 5. The options

### Option A — Keep policy + approval (status quo)
Runtime policy grants + `destructive`→approval, layered on top of whatever credential the
agent holds.

### Option B — Capability by construction (proposed)
Least-privilege scoped credentials + resource-side permissions (branch protection, repo roles)
as the enforcement points. Gateway becomes plumbing (inject/execute/redact/audit). No default
approval gate. "Human in the loop" = a PR a human merges natively.

### Option C — Hybrid
Capability-scoped by default (Option B), **plus** a *narrow, explicit* approval path for a
small allow-list of "able-but-needs-blessing" actions. The approval path is the exception, not
the default; most tools never touch it.

---

## 6. Tradeoffs

| Dimension | A: Policy + approval | B: Capability by construction | C: Hybrid |
| --- | --- | --- | --- |
| **Resistance to prompt injection** | Medium — a bug/jailbreak in the policy check is exploitable | **High** — a capability not held cannot be misused | High |
| **Implementation complexity** | High — policy engine + approval suspend/resume + hub UI | **Low** — credential storage + injection + audit | Medium |
| **Expressiveness (fine-grained rules)** | High — "comment yes, merge no", contextual rules | **Low–Medium** — limited by what tokens/permissions can express | Medium |
| **Who enforces** | Marathon (reimplements permissions) | The resource owner (GitHub, etc.) + the token | Mostly resource owner; Marathon for the exceptions |
| **Failure mode** | Policy bug → over-permit (silent) | Misconfigured/over-scoped token → over-permit (visible in token scope) | Two places to get wrong |
| **Operator burden** | Configure Marathon policy | Configure least-privilege tokens + branch protection per repo | Both, but less policy |
| **"Human blessing" UX** | In-app approval (interrupt/resume) | Native tool (merge the PR yourself) | Native by default; in-app for exceptions |
| **Auditability** | Central (gateway logs) | Central (gateway still logs) + external (GitHub audit) | Central + external |
| **Multi-tenant isolation** | Per-tenant policy + per-tenant creds | Per-tenant creds (must pick the right key per task) | Per-tenant creds |

---

## 7. What survives under *every* option (not "policy", just plumbing)

These are not trust decisions and should be kept regardless:

- **Credential isolation** — secrets live host-side (or in a broker), **never** inside the code
  sandbox. This is what makes Pattern 2 safe.
- **Secret redaction** — strip secrets from tool output before it re-enters the model context
  (a tool result must not echo the token back to the model).
- **Audit logging** — record what the agent did (observability + incident response).
- **Per-tenant credential selection** — task for tenant A uses tenant A's key, never B's.
- **Budget/spend caps** — the one limit *no* external system enforces for you (GitHub will not
  stop a runaway model-call loop). This is a resource limit, not a trust policy.

---

## 8. Known wrinkles / counterarguments (please stress-test these)

1. **GitHub tokens are coarser than the rules we'd want.** "contents: write" typically implies
   push to *any* branch including `main`. So "can't clobber main" is really enforced by
   **branch protection on the repo**, not the token and not Marathon. Is relying on
   correctly-configured branch protection a reasonable ask for self-hosters, or a footgun?
2. **Not every system has good scoping.** GitHub fine-grained PATs are decent; other
   connectors (a random internal API, a database, Slack) may only offer coarse or all-or-nothing
   credentials. Does Option B degrade to "you must build a scoped proxy per connector"? Is that
   better or worse than a central policy engine?
3. **"Just leave it as a PR" assumes a review surface exists.** It works great for code. Does it
   work for non-GitHub effects (e.g. "send this email", "delete these records")? For those,
   is a native handoff available, or do you actually need an in-app approval (Option C)?
4. **Revocation/incident response.** With policy, you flip a config to stop an agent. With pure
   capabilities, you must rotate/revoke a credential. Which is faster/safer operationally?
5. **Blast radius of a leaked/over-scoped token** vs. blast radius of a buggy policy. Which is
   the worse realistic failure?
6. **Least privilege at scale.** Managing many narrowly-scoped tokens across many
   tenants/repos/connectors is its own complexity. Does Option B trade code complexity for
   credential-management complexity — and is that a good trade?

---

## 9. Non-negotiable constraints (any proposal must satisfy)

- Code execution stays isolated in the sandbox; **no credentials in the sandbox**.
- Must work **multi-tenant** with strict per-tenant credential isolation.
- Must be **self-hostable** by a small team without a dedicated security engineer.
- Must be **robust to prompt injection** (assume the model can be adversarially steered).
- Must keep an **audit trail** of external effects.
- Must have a **host-side budget cap**.

---

## 10. What we're asking reviewers

1. Which option (A / B / C) would you choose, and why?
2. Is the core question in §4 the right hinge? What actions, if any, belong in
   "able-but-needs-in-app-blessing"?
3. Which of the §8 wrinkles is most likely to bite in practice?
4. Is "push enforcement to the resource owner (branch protection, repo roles) + least-privilege
   tokens" a sound principle, or an abdication that will fail on real, messy connectors?
5. Anything missing — a threat, an option, or a mechanism we haven't considered?

---

## 11. Decision & resulting architecture

After review (including external LLM critique), the chosen direction is **Option C, expressed as
a propose → review → execute split.** The key reframe that resolves most of the A/B/C tension:

> **The model gets Option B; the *system* gets a minimal Option C.**

The load-bearing property of the Option-B instinct — "the model never holds broad power" — is
preserved exactly: the model holds a **proposal tool**, and a separate non-model **executor**
holds the credential. Capability-by-construction still applies, to the *model's* capability set.
The small deterministic gate is a property of Marathon-the-system, not of the model. So B and C
stop competing.

### 11.1 Four layers (each does one job)

1. **Credential capability envelope** — least-privilege, tenant-owned bot/app credentials (prefer
   GitHub Apps over PATs). This is the **executor's maximum authority** (a blast-radius *ceiling*,
   not a floor), and it is about the *system's* credential, not the model's direct capability.
   Answers: *what is the most external authority this task could exercise if the workflow layer
   failed?* Keep it small.
2. **Resource-native enforcement** — GitHub branch protection / repo roles / required reviews;
   document permissions; DB roles; Slack scopes. Answers: *what does the system of record allow?*
   For code, the default is **open a PR, a human merges natively.**
3. **Deterministic safety perimeter (the gateway)** — *not* a programmable policy brain. Mechanical,
   declarative checks only: tenant↔credential isolation, allowed connector/repo/channel for the
   task, branch-name prefix, max diff size, no direct write to protected branches, rate/budget
   caps, schema validation, secret redaction, audit logging, emergency kill switch.
4. **Proposed Effects** — high-risk effects are never direct tools. The model calls one typed
   `propose_effect` tool; a workflow routes the proposal (declaratively) to autonomous /
   native-draft / in-app approval; a non-model executor performs approved effects with scoped
   credentials.

### 11.2 Risk model — retire the `destructive` boolean

`destructive: true|false` conflates "irreversible" with "dangerous" and misses the primary
threat (below). Classify effects on multiple axes instead:

| Axis | Question |
| --- | --- |
| Reversibility | Can it be undone? (edit draft vs delete record) |
| Trust-boundary crossing | Does it move info from a higher-trust source to a lower-trust sink? |
| Audience / blast radius | Private thread vs `#general` vs external/public |
| Cost | Does it spend money or scarce resources? |

The effect's routing default (autonomous / native-review / in-app approval / disabled) is a
function of these axes **plus the connector's capability profile** (§11.5).

### 11.3 The primary threat: exfiltration / confused deputy

The worst realistic prompt-injection outcome is **not** a destructive action; it is
**read-private-A → write-lower-trust-B** (e.g. summarize a private repo into a public Slack
channel), which is non-destructive by every definition. Honest consequences for the design:

- Gating *writes* does not fully close exfil: once secret data is in the model's context, any
  egress channel is a potential leak — **including "safe" ones.** "Reply in the originating
  thread" is not automatically safe if the thread's audience shouldn't see the source data.
- Therefore **least-privilege *reads*** matter as much as least-privilege writes: don't grant
  read scope the task doesn't need. Plus redaction on all egress.
- The Proposed-Effects model **mitigates** exfil for gated effects; residual exfil through
  autonomous-safe channels is managed by least-privilege reads + redaction, **not eliminated.**
  We state this rather than pretend otherwise.
- How much *internal* disclosure is acceptable is a **tenant decision**, not a platform
  absolute — see the egress policy in §11.7 (default: *on-behalf-of* the requestor).

### 11.4 Proposed Effects — invariants (what makes it a boundary, not theater)

1. **Approvals bind to the concrete artifact** (exact message/diff/recipients/mutation, hashed),
   never to an intention. If the payload changes, approval is void.
2. **The proposal is immutable once review starts.** Edits create a **new version**; approval
   applies to exactly one version; the executor runs only that version. (Prevents
   "approved one thing, executed another.")
3. **The model cannot execute** — it only enqueues; a deterministic executor performs the effect.
4. **The right principal approves.** Approval must come from a principal **authorized for the
   target resource, effect type, and blast radius** — not just any human. (See the reviewer
   table below.)
5. **Revalidate at execution** — tenant, credential, resource, destination, payload hash, and
   reviewer authority all re-checked at run time.
6. **Idempotent / replay-protected** — each approved effect carries an `idempotency_key` and
   executes **at most once** unless the workflow explicitly supports safe retry. (Guards against
   retry storms re-sending an email / re-posting a message / re-running a mutation.)
7. **Approvals expire.**
8. **Provenance is recorded and shown** ("based on repo X / issue Y / thread Z") — as *decision
   support for the reviewer and for forensics*, **not** as an automated taint-gate (which would
   over- or under-block).
9. **Typed per-connector workflows** — separate schemas for slack_post / email_send / doc_delete /
   github_merge / internal_api_call; no generic "do dangerous thing."
10. **Default to draft/review where a native surface exists** (PR for code).

**The approval/effect record binds:**

```text
effect_id · task_id · tenant_id · connector_id · effect_type
payload_hash · proposal_version · provenance
reviewer_id (+ authority check) · approval_expiry
idempotency_key · execution_state
```

**Reviewer authority (who may approve what)** — *a human* is not enough; the *right* human is.
Phase 1 keeps this to "invoking user or a configured approver"; the finer matrix is Phase 2:

| Effect | Authorized reviewer |
| --- | --- |
| Reply back to the same Slack thread | invoking user (maybe channel owner) |
| Post outside the originating thread / external channel | invoking user or configured approver |
| Send external email | invoking user or configured approver |
| Delete a document | doc owner / admin |
| Merge a PR | GitHub-native permission (not Marathon) |
| Internal production mutation | service owner / on-call / admin |
| Public / customer-facing statement | configured comms / legal / product approver |

### 11.5 Connector capability profiles (security model → product model)

Each connector declares a small profile that maps to a **default mode**. Because exfiltration is
about *broad read + apparently harmless write*, the profile has **read-side** fields too, not just
write behavior:

```text
# write side
supports_scoped_credentials:   yes | partial | no
supports_resource_permissions: yes | partial | no
supports_native_review:        yes | partial | no
supports_rollback:             yes | partial | no
supports_external_audit:       yes | partial | no
credential_lifetime:           short | long | static
max_blast_radius_if_misconfigured: low | medium | high
default_write_mode: autonomous | native_review | in_app_approval | disabled

# read side (feeds the exfiltration/audience checks, §11.3)
read_scope_granularity:  repo | channel | doc | mailbox | table | global
supports_field_redaction:      yes | partial | no
supports_row_level_permissions: yes | partial | no
source_sensitivity:      low | medium | high | customer | secret
```

**`disabled` is a general mode, not only a write mode.** A workflow system must not imply
"everything can be approved." Some capabilities are simply **unavailable** until a tenant builds a
safe connector: arbitrary HTTP requests, broad DB query access, a production shell, raw email send,
posting to external/shared channels, unscoped internal admin APIs, destructive bulk operations.

| Connector maturity | Default mode |
| --- | --- |
| Strong native scoping + review | capability-only / native handoff |
| Strong scoping, weak review | capability + selective approval |
| Weak scoping, strong review | native handoff, no direct mutation |
| Weak scoping, weak review | Proposed Effects only / no autonomous writes |

### 11.6 Two design forces to hold onto

- **The workflow must not grow a brain.** It **may** evaluate static metadata and deterministic
  predicates — connector type, effect type, destination, audience, sensitivity label, payload size,
  cost, reviewer role — but must **not** become an open-ended programmable policy engine. That line
  gives useful routing without recreating Option A (which rots). Intelligence lives in credential
  scope, resource-native permissions, and the human reading the artifact.
- **Approval fatigue is real.** Humans rubber-stamp at volume regardless of how good the diff is.
  So the objective is to **minimize how often a human is asked** — maximize native handoff and
  autonomous-safe; treat in-app approval as genuinely rare. This is the deepest argument for
  PR-as-approval: it's the human's *existing* workflow, not an extra Marathon dialog.

### 11.7 Phased plan

**Phase 1 (GitHub + Slack).** GitHub defaults to **PR-as-approval** (native handoff, ~zero in-app
approvals). Slack replies are **not** blanket-autonomous just for being in the originating thread —
they route by *type* plus the tenant's **egress policy** (deterministic checks, **not** a content
classifier):

| Slack reply | Default |
| --- | --- |
| "I'm working on it" / "I opened a PR" (status) | autonomous |
| Clarifying question to the invoking user/thread | autonomous |
| Summary of **same-thread** content only | autonomous |
| Reply carrying **private repo/doc/internal** context | **egress policy** — default *on-behalf-of*: autonomous if the requestor has access to the sources; else **denied** |
| Post to another **internal** channel | egress policy (same check; destination = that channel) |
| Slack Connect / external shared channel | `propose_effect` (every mode) |
| Broad mentions (`@channel` / `@here`) | `propose_effect` (every mode) |

**Egress policy (decided 2026-07-01).** Blanket-gating every reply that touched a private source
is too restrictive to be useful inside a company; letting anything flow anywhere makes exfil
trivial. So *internal* egress is routed by a tenant-configurable, deterministic policy:

- `open` — the tenant treats all internal audiences as equivalent; internal posts autonomous.
- `on-behalf-of` (**default**) — autonomous iff the **requesting user has access to every
  sensitive source the task read**: the agent may say to an internal audience what the requestor
  could have said themselves. Access is *verified* (via the requestor's linked identity per
  connector — e.g. their GitHub repo permission), not impersonated: the task still runs on
  tenant credentials. No access → **denied**, not proposed — an approver must not be able to
  extend the requestor's access (that grant belongs to the source system); indeterminable
  identity/access is denied too, via a **platform-generated notice** (never a model-written
  reply) prompting the user to link their identity. Prefer read-time enforcement (don't read
  what the requestor can't see); egress is the backstop. `audience`-mode failures, by contrast,
  route to a proposal — *may this content reach this audience* is a judgment an authorized
  approver can make; *does the requestor have access* is not.
- `audience` (strict) — the source-vs-audience check: the destination audience must be able to
  see every sensitive source.

All modes are predicates over static metadata (channel visibility, resource visibility, the
connector read-profile's sensitivity, requestor access) — we do not claim to detect "this
sentence contains a secret." Egress that leaves the tenant (external/shared channels, email to
external recipients, public artifacts derived from restricted sources) routes to a proposal in
**every** mode. Residual risk under `open`/`on-behalf-of` — an injected task disclosing to an
internal audience broader than the sources' — is the same disclosure the requestor could have
made by hand; mitigations are attribution, audit, the post's reversibility, and least-privilege
reads. Build: one typed `propose_effect` tool + a simple queue +
human-approves-exact-artifact + a non-model executor with scoped tenant bot credentials +
payload-hash + expiry + **idempotency**. **Define the full capability-profile schema now but fill
it only for GitHub and Slack** — don't overbuild profiles yet. Initial calibration
(2026-07-01): **all repos are `company-viewable`** — repo-derived content flows to any
internal audience in every mode; tenant-external egress stays gated. Finer
`source_sensitivity` tiers land with the first customer that needs restricted repos.

**Phase 2 (docs / email / internal APIs).** Per-connector typed schemas; **email draft-only** to
start; fill capability profiles; the reviewer-authority matrix; provenance UI. Internal APIs
pessimistic by default (reads scoped+audited, writes gated) — no "curl with vibes."

**v1 success criterion:** *a prompt-injected model can **propose** something bad but cannot
**directly execute** it.* If that holds, the architecture is doing its job.

### 11.8 The core rule (for the design doc)

> Marathon agents do not directly execute high-risk external effects **or lower-trust egress**.
> They produce typed, **immutable** effect proposals. A deterministic workflow/executor, using
> tenant-owned scoped credentials and resource-native permissions, performs **only the exact
> approved artifact, after revalidation, at most once**, and records an audit event. The gateway is
> a deterministic safety perimeter, not a policy engine.
