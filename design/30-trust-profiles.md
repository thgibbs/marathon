# 30. Trust profiles — one security model from solo dev to company

> **Status: proposed (2026-07-07).** Design + migration plan. Nothing here adds a step,
> prompt, or setup requirement to the kernel loop (§0) — the `solo` profile **is** the
> kernel's existing posture, named. The plan (§30.8) is trigger-sequenced, not date-sequenced;
> phases 2–4 mostly re-sequence already-planned work (M9 remainder, M10 Phase 2, OQ-4/OQ-6
> reopens) rather than adding new work.

## 30.1 The tension, named

Marathon serves two deployments that want opposite defaults:

* **A solo developer** on their own repo(s). Everything is about efficiency: permissions
  given freely, zero approval dialogs, zero identity ceremony, ≤30-minute quickstart (K6).
  The security that actually matters is exactly two things: **no exfiltration of keys or
  secrets**, and **no destructive action without permission** (deleting a database — no;
  opening a PR or committing to an agent branch — yes, freely).
* **A team / company** (multiple developers, multiple projects, eventually multiple
  tenants). Now identity, authorization, audience bounds, audit, retention, and isolation
  are real requirements, and "permissions given freely" is a liability.

Today the corpus *leans* progressive — capability-first enforcement ([`policy.md`](../policy.md)),
kernel-vs-deferred scoping (§0.4), tenant-configurable egress modes (§7.8) — but the
**posture is smeared across scattered knobs** with no single declaration of which deployment
you are: `chat.trusted_deployment` (per-agent YAML), `MARATHON_SANDBOX` /
`MARATHON_SANDBOX_NETWORK`, `CONSOLE_ALLOW_NONLOOPBACK`, `MARATHON_TENANT`, the OQ-4
"all repos company-viewable" calibration, memory write gating, budget policy JSON. Each knob
is individually findable and individually missable. The failure mode is not a missing
mechanism; it is a team deployment still running one solo-shaped default it never knew about.

## 30.2 The principle: profiles change defaults, never mechanisms

A **trust profile** is a named preset — `solo | team | org | hosted` — declared once per
deployment (later per tenant) that sets the *default* value of every posture knob the system
already has.

* **One code path.** Solo and company run the same gateway, sandbox, effects machinery, and
  memory gating. There is no `if (dev) skip_check` branch anywhere — the classic hole where
  a convenience bypass becomes permanent. Growing solo → team → org is a **config change plus
  a migration checklist (§30.6)**, never a re-architecture.
* **A finite table, not a policy DSL.** The §11.6 "the workflow must not grow a brain" force
  applies here too: a profile is a row of defaults over existing knobs. If a knob doesn't
  exist as a mechanism, the profile cannot express it.
* **The floor never moves (§30.3).** Every profile, including `solo`, keeps the invariants.
* **Each tier's checks are meaningful, not theatrical.** Under `solo`, the requestor *is* the
  operator *is* the credential owner — `on-behalf-of` would verify a tautology, and
  `chat.trusted_deployment` is *correct*, not a compromise. Relaxing those checks at that
  tier isn't a security discount; it's removing a vacuous check. The threats that **don't**
  collapse when you're alone — an injected model exfiltrating secrets or destroying things —
  are exactly the floor.

## 30.3 The floor — invariant in every profile

The floor is **built** (M3/M6.1/M9, M10 Phase 1) up to three as-built deltas noted inline
(the model-credential carve-out in #1, refusal-vs-proposal in #5, the opt-in budget default
in #7). Together the eight are precisely the solo developer's stated requirement set:

1. **Tool and tenant credentials never enter the sandbox or the model context.** Host-side
   injection only (gateway `ctx.secrets`, command-broker child-env-only — never argv, never
   traces); workspaces are materialized **credential-stripped** (§29.2). **Stated exception —
   the model credential under Claude Code `bridge`:** that harness calls the model itself,
   so the API key / subscription token enters the container env
   (`claude-code-impl.md` §4.1; `modelAccessEnv` in `packages/agent/src/claude-code.ts`),
   guarded by redaction of everything the CLI echoes back. Proxy-only model access (key
   host-side, container carries a placeholder) is the locked posture and becomes floor at
   `hosted`; until then this is the floor's one scoped carve-out, stated rather than hidden.
2. **Secret redaction on every boundary crossing** — broker responses, tool output
   summaries, step outputs (`redact.ts`; patterns for Anthropic/Slack/GitHub/AWS keys).
3. **All code execution in a sandbox; no implicit host shell.** `NoSandbox` refuses;
   fail closed on provisioning errors (§12.6).
4. **No irreversible/destructive external effect without an explicit human act** — native
   (a PR a human merges, §29.1a) or an approved Proposed Effect (§7.9). The model never
   holds a destructive tool directly; approval binds to the exact payload hash, executes
   at most once.
5. **Tenant-leaving egress is never autonomous**, in every profile and every egress mode
   (§7.8) — external/shared channels, external email, public artifacts. As built, the
   gateway **refuses** direct external egress (`checkEgress`) and no external-egress tools
   are registered; the *proposal route* for it lands with M10. P0 tests assert
   blocked/refused, not proposal-created.
6. **Audit event per governed effect** (and per denial).
7. **Hard budget cap**, fail-closed at turn boundaries (§7.11, §13.3). As built the cap is
   **opt-in** (`AgentSpec.budget` omitted → no enforcement) — P1 gives every profile a
   **default cap**, so omission means the profile default, not "unlimited" (this matches
   kernel intent: §0.4 already names a hard per-task cost cap). Under subscription auth
   billable spend is $0; runaway runs are bounded by `--max-turns` + provider rate limits
   instead of the dollar kill.
8. **Untrusted-content fencing** in prompt assembly (`fenceUntrusted`, §12.2).

**One residual stated honestly (solo).** Under the default `bridge` sandbox network, an
injected agent's *code* could POST **workspace contents** (your private repo's text)
outbound — credentials are floor-protected everywhere, repo text under `bridge` is not.
This is the OQ-4 calibration ("company-viewable") applied to a repo whose company is you.
The one-line lockdown exists today **for the Pi harness only**: `sandbox.network: none` —
Pattern 2 keeps the model call host-side, so nothing else breaks. **Not yet for Claude
Code:** lockdown there requires the internal-network model proxy (K7 spike, §7.1), and the
build wiring **fails closed** — `harness: claude-code` + `sandbox.network: none` is rejected
at wiring time (`packages/github-app/src/build.ts`) until that spike lands, so under Claude
Code the bridge residual currently has no mitigation beyond the credential floor. The cost
of lockdown on Pi is in-container installs (`pnpm install`), which is why `bridge` stays the
solo default; §30.9 tracks flipping that default once the proxy path + install caching make
lockdown free.

## 30.4 The profiles

* **`solo`** *(the out-of-the-box default; the kernel posture, §0.4).* One human who is
  requestor, approver, admin, and credential owner. Zero identity ceremony, zero in-app
  approvals (native PR merge only), broad tool grants in the agent YAML. The floor is the
  security model.
* **`team`** *(trigger: a second human joins the workspace).* Multiple trusted humans, one
  org, repos effectively company-viewable. Identity now exists as a question, so it must be
  proven: linking (§7.20) turns on, `on-behalf-of` egress becomes the default, the console
  gets auth, approvals need a named approver.
* **`org`** *(trigger: the first restricted repo, or the first customer org.)* Multiple
  projects with different audiences. Sensitivity tiers get filled (OQ-4 reopens), roles are
  enforced, retention becomes configurable, the hub arrives with SSO.
* **`hosted`** *(trigger: running tenants that aren't you — hostile multi-tenant SaaS.)*
  The M9-remainder hardening: microVM isolation, uid mapping, external review.

| Knob (mechanism, where it lives today) | `solo` | `team` | `org` | `hosted` |
| --- | --- | --- | --- | --- |
| Tenancy (`MARATHON_TENANT`, surface bindings §2b #14) | one tenant | one tenant | one tenant, many projects | many tenants |
| Identity linking (§7.20, built) | **off** — unneeded | required for private grounding + approvals | required; IdP bulk provisioning | required |
| `chat.trusted_deployment` (agent YAML) | **on** (profile-implied) | off | off | **forbidden** |
| Internal egress mode (§7.8) | `open` | `on-behalf-of` | `on-behalf-of` or `audience` | `audience` |
| Tenant-leaving egress | proposal — **floor** | floor | floor | floor |
| Source sensitivity (OQ-4) | all company-viewable | all company-viewable | tiers + per-repo overrides | tiers required |
| Memory write gating (§7.12, built) | ungated (one writer, nothing to poison but your own tasks) | tenant-scope writes confirmed | confirmed + review at publish | confirmed |
| Who may invoke an agent | anyone in the workspace (= you) | workspace members; optional per-agent channel allowlist | roles enforced (§10.2 `Role`) | roles + tenant isolation |
| Reviewer authority (§7.9) | any human (= you) | invoking user or configured approver | the authority matrix (`policy.md` §11.4) | matrix, tenant-scoped |
| Console / hub access | localhost, no auth (as built) | authenticated | SSO + RBAC + audit views | hosted auth |
| Sandbox backend (§12.6) | docker | docker | docker | microVM |
| Sandbox network (`sandbox.network`) | `bridge` (installs; residual stated in §30.3) | `bridge` | locked (proxy-only) | locked |
| Retention (§12.5, OQ-6) | keep everything | keep everything | per-class configurable | contractual |
| Budgets (§13.3, built) | per-task cap — **floor** | + per-agent / per-tenant | + alerts, dashboards | strict per-tenant |

## 30.5 Ratchet and override semantics

* **Tightening is fail-closed and immediate — which is not the same as seamless.** Flipping
  `solo → team` never *loosens* anything, but flows in flight can start denying: private-repo
  grounding denies until users complete §7.20 linking (§30.6 step 1), and the console has no
  auth to turn on until P2 ships it. Run the §30.6 preflight checklist before flipping;
  "safe" means fail-closed, not uninterrupted.
* **Loosening is explicit, loud, and audited.** Any knob set looser than the profile default
  requires an acknowledgment-shaped config (the pattern `CONSOLE_ALLOW_NONLOOPBACK=1`
  already established — generalize it), emits a startup warning, and writes an audit event.
* **The floor is not overridable** by any profile or knob.
* **The startup posture banner.** Each live app prints its effective posture at boot —
  profile, every knob that deviates from the profile default, and the loosenings — extending
  the §2b #13 fail-loud rule from "which webhook mode am I in" to "which trust posture am I
  in". A team deployment silently running a solo default becomes impossible to miss.

## 30.6 Upgrade paths (migration checklists, not migrations)

**`solo → team`** (the one that matters first):

1. Set `trust_profile: team`. `chat.trusted_deployment` flips off — private-repo grounding
   now **denies with the link-your-GitHub CTA** (§7.8) until users complete §7.20 linking.
   This is the intended behavior, not breakage; the operator links first, teammates link on
   first denial.
2. Enable console auth (§30.8 P2 builds it); stop relying on localhost-only.
3. Review agent YAMLs: tool grants written for one person are now exercised by many —
   confirm repo allowlists and command families still match intent.
4. Name approvers (reviewer-authority config) for any proposed-effect types in use.
5. Memory written under `solo` was single-writer and stays valid; tenant-scoped writes now
   require confirmation going forward. No data migration.
6. Rotate any credentials that were handled loosely during solo operation (hygiene, not a
   mechanism).

**`team → org`:** fill sensitivity tiers for restricted repos (per-repo overrides, OQ-4
reopen); assign roles; configure retention; move approvals into the hub with SSO.

**`org → hosted`:** microVM backend, uid mapping, per-tenant pen-test posture — the
M9-remainder list, unchanged.

## 30.7 Reconciliation with the as-built code (2026-07-07 survey)

The architecture is *already* progressive; the tension is real but lives in configuration,
not mechanism. What the survey found:

**Built and floor-complete:** tenancy scoping + surface bindings (migrations 0004/0010),
the `ToolGateway` chokepoint with egress routing (external → proposal, restricted-source →
deny, read ledger), the host broker + MCP shim + command broker (credential-free sandbox,
child-env-only creds, minimal env), AES-256-GCM secret storage + redaction at every
crossing, hardened per-task containers (pinned image, resource limits, owner-tagged reaping),
Proposed Effects with payload-hash binding + at-most-once execution, identity linking
(OAuth, single-use nonce, stale-on-refresh-failure), per-user repo access checking,
audience-scoped memory (migration 0009), budgets with the subscription/API cost split.

**Solo-shaped decisions already made, now to be named as profile defaults rather than
scattered facts:** `chat.trusted_deployment` (documented "unsafe for shared workspaces,"
guarded only by a log line), the OQ-4 company-viewable calibration, `bridge` sandbox
network, localhost-only console, `MARATHON_TENANT` single-tenant binding, external egress
simply-not-wired (§0.4).

**Gaps, mapped to the tier that needs them** (nothing on this list blocks `solo`):

| Gap | Needed by | Today |
| --- | --- | --- |
| Console/hub auth | `team` | localhost-only; `CONSOLE_ALLOW_NONLOOPBACK=1` escape hatch, no auth story |
| Per-agent invocation scoping | `team` | anyone in the workspace can invoke any agent |
| Effect executors beyond `github_merge` | `team`+ | only the GitHub merge executor is wired |
| Reviewer-authority config beyond invoking-user | `team`/`org` | Phase-1 minimal |
| Role enforcement | `org` | `Role` enum stored, **checked nowhere** |
| Sensitivity tiers + per-repo overrides | `org` | schema defined, values unfilled (OQ-4, deliberate) |
| Retention | `org` | punted (OQ-6, deliberate) |
| Hub + SSO | `org` | M10 Phase 2, unbuilt |
| Egress-source ↔ memory tie-in | `org` | queued with M10 (§2b #9 remainder) |
| microVM, uid mapping, `grep/find/ls` routing | `hosted` | M9 remainder |

The punchline: the corpus already contains ~90% of the ladder. What's missing is (a) the
single `trust_profile` declaration binding the scattered knobs, (b) three team-tier gaps
(console auth, invocation scoping, more executors), and (c) work that was *already* planned
and deliberately deferred (org/hosted tiers), which the profile merely sequences by trigger.

## 30.8 The plan

* **P0 — Name the floor, test the floor** *(now; kernel-compatible, small).* Write §30.3
  down as the explicit contract and make the regression suite match it one-for-one —
  extend `demo-m9` (or split a `demo-floor`): injected-agent credential-exfil attempts
  (sandbox env, brokered argv, tool-output echo), destructive attempt → proposal-or-refuse,
  tenant-leaving egress → **refused** (the proposal route lands with M10; assert the block,
  not a proposal), redaction across the broker, budget kill. Most fixtures
  exist; the deliverable is the named contract plus the few missing cases. Zero new
  user-facing surface. **As-built (2026-07-08):** split as `demos/floor/` — a
  deterministic, in-memory suite (no Postgres/Docker) with one case per §30.3
  invariant and the two residuals documented in its README (`make demo-floor`).
* **P1 — The profile knob** *(small; slipstreams after P0 without touching the K-series).*
  `trust_profile: solo | team | org | hosted` in deployment config, defaulting `solo`; bind
  the existing knobs' defaults to it (including making the internal egress *mode* a real
  config the gateway reads — the modes are designed in §7.8 but the knob doesn't exist yet);
  a **default budget cap per profile** (an omitted `budget:` means the profile default, not
  unlimited — closes the floor-#7 delta); the startup posture banner; the generalized
  loosening-ack pattern. Quickstart changes **not at all** — `solo` is the silent default.
  **As-built (2026-07-08):** `MARATHON_TRUST_PROFILE` on `Config` (default `solo`);
  `packages/config/src/profile.ts` holds the `PROFILE_DEFAULTS` table, `resolvePosture`
  (with the `MARATHON_ALLOW_LOOSER_EGRESS` / `MARATHON_ALLOW_TRUSTED_DEPLOYMENT` acks) and
  `renderPostureBanner`; `resolveEffectiveBudget` + `resolveEffectiveTrustedDeployment`
  (tri-state `chat.trusted_deployment`) bind the per-agent knobs; the gateway reads
  `internalEgressMode`; both live apps print the boot banner. The internal egress *mode*
  is read (and audited) but stricter-than-`open` enforcement lands with its tier (P2/P3).
* **P2 — Team tier** *(trigger: second human).* Console/hub auth (decide the mechanism —
  §30.9); per-agent channel allowlist for invocation; reviewer-authority config; wire the
  next effect executors as real usage demands them; publish the §30.6 solo→team checklist.
* **P3 — Org tier** *(trigger: first restricted repo or first customer org).* Enforce
  `Role`; reopen OQ-4 (fill tiers, per-repo tenant overrides); retention (reopen OQ-6);
  hub + SSO (M10 Phase 2); the egress-source memory tie-in.
* **P4 — Hosted tier** *(trigger: running others' tenants).* M9 remainder (microVM, uid
  mapping, route `grep/find/ls`); external security review / pen test (the M9 human
  prerequisite).

Roadmap slotting: P0 folds into the kernel's hardening posture; P1 is a small standalone
track; P2–P4 are mostly existing roadmap items (M9 remainder, M10 Phase 2, OQ reopens)
re-sequenced under explicit triggers instead of a milestone date.

## 30.9 Open edges

* **Console/hub auth mechanism for `team`** — a shared token, surface OAuth (reuse the
  §7.20 GitHub App), or SSO-lite? Decide at P2; leans surface-OAuth to avoid a new
  credential.
* **Invocation ACL shape** — per-agent channel allowlist (Slack-native, cheap) vs. role
  check. Leans allowlist at `team`, roles at `org`.
* **Solo sandbox network default** — flip `bridge → locked` once the internal-network
  model-proxy spike lands (today locked-down Claude Code is rejected fail-closed at wiring)
  and install caching makes lockdown friction-free; until then the §30.3 residual stands,
  stated. The same spike retires the floor-#1 model-credential carve-out.
* **Per-tenant profiles under `hosted`** — the profile is per-deployment until multi-tenant
  hosting exists; the knob table is already per-tenant-shaped (tenant `settings`/`policies`
  JSONB) when that day comes.
