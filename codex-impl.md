# Codex headless harness (K8) + per-kernel-stage model routing

Answers a Slack ask (thread with `@forge`): run agents on **Codex CLI in headless mode** as
a third harness, and let a deployment pick a **different model for each kernel-loop stage** —
drafting the design plan, reviewing the plan PR, implementing the merged plan, and reviewing
the implementation PR.

These are two independent, additive changes to the same seam (`AgentRuntime` + the agent
YAML's `models:` policy), sequenced so the smaller one ships first. Part A has no dependency
on Part B and vice versa.

---

## Part A — Event-scoped agent dispatch + per-kernel-stage model routing

### A.1 What exists today

The model-routing primitive already exists and is more general than the ask needs:
`AgentModelPolicy` (`packages/config/src/index.ts`) is an **open role → `provider:model` map**
(`{ default, [role]: string }`), and `resolveModelRef(policy, role)`
(`packages/model-gateway/src/index.ts`) resolves a role to a ref, falling back to `default`.
Design §7.10/§7.19 already describe this as "role → tier → model"; §7.19's as-built note says
role routing "remains open" — true for *general per-step* routing within a task, but the BUILD
wiring (`packages/github-app/src/build.ts`) already resolves one concrete role today:

```ts
const modelRef = resolveModelRef(spec.models ?? DEFAULT_MODEL_POLICY, "build");
```

What's missing is not the mechanism — it's that only **one** of the kernel loop's four stages
is wired to a distinct role. The other three all collapse onto a single flat value:

| Kernel stage (§0.1 loop: ask → design doc → review → merged plan → code → PR) | Call site | Model used today |
| --- | --- | --- |
| **Draft** the design doc | `handleGithubMention` draft path (`packages/github-app/src/handlers.ts`) | `deps.modelRef ?? "openai:gpt-4o-mini"` — a flat default, ignores `spec.models` |
| **Review**: revise the design doc from PR review comments | `handleGithubMention` revise path + `handleGithubReview` (doc branch) | same flat `deps.modelRef` as draft — indistinguishable from it |
| **Build**: implement the merged plan | `makeBuildWiring` → `makeBuildStepRunner` | `resolveModelRef(spec.models, "build")` — already role-routed |
| **Review**: revise the code PR from review comments/mentions | `handleCodePrRevision` → routed through `isBuildTask` to the same BUILD step runner | same `"build"` role as fresh implementation — indistinguishable from it |

So today an operator can already give BUILD its own model, but cannot give DRAFT a cheaper
model, cannot give doc-REVIEW a different model than DRAFT, and cannot give a post-merge
code-REVIEW pass a different (e.g. more careful/adversarial) model than BUILD itself. There is
also, today, no notion of an agent *subscribing* to a kind of happening at all — one agent
instance implicitly handles all four stages because the control flow in `handlers.ts`/
`build.ts` hardcodes which function runs for which webhook. §A.2 names that gap explicitly.

### A.2 Three abstractions (per review feedback)

Talking only in terms of a flat "role" string undersold what's actually configurable here.
Naming the pieces explicitly:

- **Event** — something that happened and needs a response: an ask/mention on an issue with no
  existing doc, a review comment on a design-doc PR, a plan PR merging, a review comment or
  mention on a code PR. Broader event types (`pr_opened`, `label_added`, a plain `comment` with
  no action requested, etc.) are conceivable in general, but this pass scopes to the four
  events the kernel loop already produces end to end — see §A.3.
- **Agent** — a `harness` + instructions + a `models` policy (`AgentSpec`, unchanged shape).
- **Model** — `provider:model`, resolved per event via `resolveModelRef` (unchanged mechanism).

Today's config already has agent and model as first-class concepts; it has no explicit,
configurable notion of event — the mapping from "a GitHub webhook fired" to "which agent
responds" is hardcoded, single-agent, no subscription list. §A.3–A.4 make that mapping
explicit and let more than one agent subscribe to the same event.

### A.3 Decision: four canonical events; agents subscribe via `on:`

Introduce four **reserved event names**, one per kernel stage, resolved via the existing
`resolveModelRef` at each call site instead of a flat default — and add an `on:` field to
`AgentSpec` naming which events a given agent responds to:

```yaml
name: forge
harness: claude-code
on: [draft, review, build, revise]   # events this agent responds to; omit = all four (today's behavior, unchanged)
models:
  default: openai:gpt-4o-mini   # required; fallback for any event not set below
  draft:   openai:gpt-4o        # drafting the design-doc PR
  review:  openai:gpt-4o        # revising the design doc from human review comments
  build:   openai:gpt-4o        # implementing the merged plan               (existing role)
  revise:  openai:gpt-4o        # revising the code PR from human review comments/mentions
```

No config-schema change beyond the new `on:` field: `AgentModelPolicy`/`ModelPolicy` are
already open maps, so the `models:` side is a **naming convention**, not a new field. `on:`
defaults to all four events when omitted, so an agent that sets neither `on:` nor any
model-policy entries keeps behaving exactly as it does today — one agent, every stage, every
model resolving to `default`.

A deployment can register more than one `AgentSpec` (already possible — `21-example-agents.md`
shows several sample agents). Two or more specs may list `draft` in `on:` — e.g. a `forge`
agent handling `draft`/`build` alongside a separate `security-reviewer` agent that also lists
`on: [draft, review]` and drafts its own independent doc PR from the same ask, with its own
instructions/model. Each drafted artifact is owned by the agent that drafted it; §A.4 fans out
`draft` to every subscribed agent, but routes each artifact's `review` events only back to its
owning agent — never to every agent subscribed to `review` in general. A spec that subscribes
to `review` without also subscribing to `draft` will never own an artifact and so is never
invoked; see the validation note in §A.4 item 4.

**Why these four events and not, say, a fifth "self-review before requesting human review"
event:** the loop has no such step today — DRAFT hands straight to a human-reviewed PR, and
BUILD hands straight to a human-reviewed PR (§29.9: native review is the review surface for
both). "review" and "revise" name the *agent's own* response to that human review, which is
the concrete, already-existing work each does. Stated assumption, open to renaming in review —
no code depends on these four literal strings existing anywhere but the call sites below.

### A.4 Wiring changes

Four call sites change from a flat/shared/single-agent model to an event-routed,
multi-agent-capable one:

1. **`GithubAppDeps.modelRef`** (`packages/github-app/src/handlers.ts`) — replace the single
   `modelRef?: string` field with an event-routed dispatch:
   - `handleGithubMention` draft path → fan out to every registered `AgentSpec` whose `on:`
     includes `draft` (today: exactly one, so this is a superset of current behavior), each
     resolved independently via `resolveModelRef(models, "draft")`. Each spec's draft run opens
     its own doc-PR branch; that branch is stamped with the drafting agent's id (spec name) in
     the branch's tracked metadata (alongside whatever else the draft path already records for
     the branch → task mapping).
   - `handleGithubMention` revise path (existing artifact branch) / `handleGithubReview` doc-PR
     branch → **ownership-routed, not fanned out**: look up the agent id stamped on the target
     branch at draft time and resolve `resolveModelRef(models, "review")` for *that one spec
     only*, regardless of how many other specs list `review` in their `on:`. A spec that lists
     `review` without ever having drafted the artifact under review is simply never invoked for
     it — see the validation note below.
   - **Why draft fans out safely but review must not**: `draft` opens an independent doc-PR
     branch per subscribed agent, so two agents responding to the same `draft` event produce
     two independent PRs with no shared state. `review`, in contrast, is always about one
     specific existing branch; if it fanned out to every agent subscribed to `review` the way
     `draft` fans out, two agents could both call `document.revise` against that one branch and
     race/overwrite each other's commits — the exact hazard §A.4 item 3 already calls out for
     `build`/`revise`, just reachable through `review` too if left unfixed. Routing by the
     branch's recorded owner instead of by subscription list closes that gap without needing
     branch-per-agent machinery for review.
   - **Config-validation consequence**: an `AgentSpec` that lists `review` but not `draft` (or
     `revise` but not `build`) can never be dispatched to under ownership routing, since it will
     never own an artifact. `validateHarnessConfig` (item 4 below) warns on this combination
     rather than failing closed, since it's a likely misconfiguration (e.g. a typo'd `on:` list)
     but not an unsafe one.
2. **`makeBuildWiring`** (`packages/github-app/src/build.ts`) — unchanged for fresh
   implementation (`"build"` role stays as-is), except it now resolves the set of specs
   subscribed to `build` rather than assuming exactly one.
3. **BUILD step runner role split** — `handleCodePrRevision` spawns a `code_revision` task that
   is currently routed by `isBuildTask`/`makeLoopStepRunner` to the *same* BUILD step runner
   instance, which was constructed with one baked-in `modelRef`. To give code-review/revision
   its own role, `makeBuildStepRunner`'s `modelRef` option becomes resolved **per task** from
   the task's `sourceRef.kind` rather than fixed at construction:
   ```ts
   // packages/worker/src/build-step.ts (sketch — exact shape decided in BUILD)
   modelRef: (task) => resolveModelRef(models, task.sourceRef.kind === "code_revision" ? "revise" : "build"),
   ```
   This is the one call site that isn't a straight one-line swap — everywhere else the role is
   known statically at the call site.

   **`build`/`revise` do *not* get multi-agent fan-out in this pass**, unlike `draft` above:
   both write commits to one shared PR branch (the code PR), and two agents pushing concurrent
   commits to the same branch is a real conflict (racing pushes, overlapping edits), not a
   cosmetic one. If more than one `AgentSpec` subscribes to `build` or `revise` for the same
   repo, dispatch picks the first registered spec and logs a warning that the others were
   skipped — full support (branch-per-agent, or serialized turns) is future work, tracked as a
   non-goal in §A.5.
4. **`validateHarnessConfig`** (`packages/config/src/index.ts`) — already iterates
   `Object.entries(spec.models)` generically for the `claude-code` Anthropic-only check, so the
   two new roles (`draft`, `review`, `revise` — `build` already covered) are validated for free;
   no change needed there. The new `on:` field gets a small validation of its own: unknown event
   names fail closed with a config error (rather than silently never firing). It also warns
   (not fails) when a spec lists `review` without `draft`, or `revise` without `build` —
   ownership routing (item 1) and first-registered-wins (item 3) mean such a spec can never
   actually be dispatched to, which is more likely a typo than an intentional read-only
   listener.

### A.5 Non-goals (this pass)

- **Not** general per-step routing inside a single harness turn/session (§7.19's broader
  "classify_intent / plan_task / safety_check" vision stays open, unrelated to this ask).
- **Not** a new budget/cost dimension — `ModelInvocation` already records `provider`/`model`
  per call; per-role cost is answerable today from that + which call site ran (no new column).
  Attaching an explicit `role` tag to `ModelInvocation` for direct dashboard filtering is a
  reasonable small follow-up, not required to satisfy the ask.
- **Not** a fallback chain or constraint filter (§7.19 §Selection procedure steps 4–5) — out of
  scope; `resolveModelRef`'s existing default-fallback is all that's needed here.
- **Not** a general event bus / pub-sub infrastructure — `on:` is a static subscription list
  checked against the four fixed events the kernel loop already produces from GitHub webhooks
  (issue mention, doc-PR review, plan-merge, code-PR review/mention). No new event sources, no
  dynamic registration, no cross-repo fan-out in this pass.
- **Not** multi-agent fan-out for `build`/`revise` — see the conflict note in §A.4 item 3;
  first-registered-spec-wins plus a warning is the interim behavior, not a real solution.
- **Not** any priority/exclusivity mechanism for `draft`, the one event that fans out to every
  subscriber — if two specs subscribe to `draft`, both run, unconditionally; there's no config
  knob to make them mutually exclusive or to rank them. (`review`/`revise`/`build` don't need
  this: `review` is ownership-routed to a single agent per artifact, §A.4 item 1; `build`/
  `revise` use first-registered-wins, §A.4 item 3.)

### A.6 Risk / cost note

Splitting `review`/`revise` from `draft`/`build` lets an operator route the (usually shorter,
more surgical) review/revise turns to a cheaper model than the (usually longer, more
generative) draft/build turns, or vice versa — purely an operator choice; this doc does not
recommend a specific split. Multi-agent fan-out on `draft` (§A.4 item 1) multiplies model spend
by the number of subscribed agents for that event specifically — `review` doesn't add this
cost since it's ownership-routed to one agent per artifact, not fanned out — worth calling out
to operators in the docs, though not a reason to gate the feature.

---

## Part B — Codex CLI headless harness (K8)

### B.1 What Codex headless is

**Codex CLI** (`@openai/codex`) is OpenAI's open-source coding-agent CLI. Non-interactive
automation runs through **`codex exec`**: no TUI, prompt in, agent loop out, process exits —
the same shape as Claude Code's `claude -p`. Verified against the official docs
(developers.openai.com/codex, July 2026); as with `claude-code-impl.md`, **pin an exact CLI
version** in the sandbox toolchain image and re-verify the items marked *verify-on-pin* (§B.9)
against that version before relying on them — Codex CLI ships fast and some of what follows is
undocumented or was found only in a GitHub issue, not the reference docs.

- `codex exec "<prompt>" --json` streams newline-delimited JSON events to stdout and prints
  only the final agent message; event types: `thread.started`, `turn.started` /
  `turn.completed` / `turn.failed`, `item.started` / `item.completed` (covering agent messages,
  reasoning, command execution, file changes, **MCP tool calls**, web searches, plan updates).
- `codex exec resume [SESSION_ID]` (or `--last` for the most recent session in the cwd)
  continues a prior non-interactive run — the resume primitive Marathon needs for §11.2
  checkpointing.
- `--sandbox {read-only|workspace-write|danger-full-access}` is the CLI's **own** sandbox
  policy for model-generated commands (defense-in-depth only, per the same reasoning as
  Claude Code's `--permission-mode` — §B.6).
- `--model` selects the model; `--cd` sets the workspace root; `-c key=value` overrides
  `config.toml` entries; `--ephemeral` skips persisting session rollout files (Marathon does
  **not** want this — durable, resumable sessions are the point).
- MCP servers are configured in `config.toml` (`[mcp_servers.<name>]`, stdio or HTTP
  transport) — this is how Marathon's governed tools attach, mirroring the
  `--mcp-config`/`--strict-mcp-config` shape used for Claude Code.
- Auth: reuses saved CLI credentials (a ChatGPT-account login) by default, or an explicit
  `CODEX_API_KEY` env var for a single invocation.

Sources: [Non-interactive mode](https://developers.openai.com/codex/noninteractive),
[Command line reference](https://developers.openai.com/codex/cli/reference),
[Configuration reference](https://developers.openai.com/codex/config-reference).

### B.2 Marathon fit — same Pattern 1 shape as Claude Code

Codex is a second instance of the shape `claude-code-impl.md` §1 already generalized: the whole
agent loop runs *inside* the sandbox container as a subprocess; file/bash tools are contained
by construction; governed tools are brokered back to the host over MCP; the model call exits
only through host-controlled auth (direct key or proxy). Nothing here is Codex-specific enough
to need a new isolation pattern — it reuses `marathon-mcp-shim`, `serveToolBroker`, and
`ToolGateway.run` exactly as Claude Code does (`claude-code-impl.md` §3).

```text
        HOST (trusted)                          │   SANDBOX CONTAINER (untrusted)
                                                │
  CodexAgentRuntime.nextTurn()                  │
    └─ docker exec: codex exec --json           │   codex CLI (pinned)
         [resume <sid> |] "<prompt>"    ───────┼──►  agent loop
    ◄── JSONL events on stdout ─────────────────┼───  workspace-write sandbox → /workspace only
                                                │       │
  serveToolBroker on unix socket  ◄─────────────┼─── marathon-mcp-shim (same shim as Claude Code;
    └─ ToolGateway.run (unchanged)              │        Codex is just another MCP client)
                                                │
  model access (§B.5):                          │
    direct CODEX_API_KEY (bridge default) ──────┼──► OpenAI  (no proxy)
    locked-down → key-injecting proxy ◄─────────┼─── base-URL override (verify-on-pin, §B.9)
```

### B.3 Turn model

- **One harness turn = one `codex exec` invocation.** First turn: `codex exec --json
  "<prompt>"`; later turns: `codex exec --json resume <session-id> "<prompt>"`.
- **Checkpoint cadence — open question.** Claude Code bounds a harness turn with `--max-turns`
  so an unbounded BUILD invocation can't become one giant uncheckpointable turn (§11.2). The
  Codex CLI reference found **no equivalent per-invocation turn cap flag**. Until confirmed
  otherwise (*verify-on-pin* #1, §B.9), treat this as a real gap, not an oversight to route
  around silently: either (a) the CLI has an undocumented cap worth finding, (b) Marathon
  imposes its own wall-clock/turn-count watchdog that SIGTERMs the `codex exec` process (same
  "kill and resume from the last snapshot" contract §11.2 already specifies for a crash), or
  (c) checkpointing degrades to whole-invocation granularity for Codex specifically (accepted,
  documented risk) until upstream adds a bound. **Recommendation: (b)** — a
  Marathon-side timeout is harness-agnostic and doesn't block on upstream; specify the timeout
  as a `maxTurnsPerInvocation`-equivalent config knob for parity with `ClaudeCodeAgentOptions`.
- **`AgentTurn` mapping** (mirrors `claude-code-impl.md` §2.2):

  | `AgentTurn` field | Codex JSON-event source |
  | --- | --- |
  | `text` | the final `item` of type agent-message on `turn.completed` |
  | `modelInvocation` | usage/cost fields on `turn.completed` — **unconfirmed schema, verify-on-pin #2** |
  | `done` | `turn.completed` **and** no pending `ask_user`; `turn.failed` ⇒ handled like Claude Code's `error_max_turns` (not-done, checkpoint, retry) |
  | `waiting` | set when the run ends after an `ask_user` MCP call (same shim-level convention as Claude Code, §B.4) |
  | `sessionRef` | the Codex session id (from `thread.started`) + the turn-snapshot path |
  | `turnIndex` | Marathon's own counter, same as both existing harnesses |

### B.4 Governed tools over MCP

Codex attaches Marathon's governed tools exactly like Claude Code: `marathon-mcp-shim` as a
stdio MCP server in `config.toml`'s `[mcp_servers.marathon]`, forwarding every `tools/call` to
the host broker. **Reused verbatim — no new shim.**

**Default: `--ask-for-approval never` with the Marathon MCP server pre-approved, not `--yolo`.**
The current non-interactive-mode docs document `--ask-for-approval never` as the intended flag
for headless runs, and the MCP configuration reference documents a `default_tools_approval_mode
= "approve"` setting (plus a narrower per-tool `approval_mode` override) for marking specific
MCP servers/tools as pre-approved rather than prompted. The primary invocation shape is:

```
codex exec --json --sandbox workspace-write --ask-for-approval never
```

with `config.toml`'s `[mcp_servers.marathon]` entry setting `default_tools_approval_mode =
"approve"` (or per-tool `approval_mode` entries scoped to the specific governed tools) so every
`marathon-mcp-shim` tool call is pre-approved instead of prompted or auto-cancelled. This keeps
the CLI's own `--sandbox workspace-write` policy active as real defense-in-depth, rather than
disabling it — no `--yolo` needed on the happy path.

**Fallback, not default: `--yolo` if the pinned CLI still reproduces the auto-cancel bug.**
[openai/codex#24135](https://github.com/openai/codex/issues/24135) reported that, on earlier
CLI builds, `codex exec` auto-cancelled MCP tool calls in non-interactive mode regardless of
approval mode — stdin closed, nothing to answer a prompt, and the pre-approval config above
didn't help. If *verify-on-pin* #3 finds the pinned version still reproduces that bug, fall
back to `--dangerously-bypass-approvals-and-sandbox` (`--yolo`), which also disables the CLI's
own sandbox policy. The same argument Claude Code already relies on for `--permission-mode
bypassPermissions` (`claude-code-impl.md` §3.3: "the harness's own permission machinery is
defense-in-depth, never the security boundary — containment (the container) and the gateway
(host-side) are the boundary") covers this fallback too: Marathon's Docker container is the
file/process boundary and `ToolGateway.run` is the effect boundary, regardless of whether the
CLI's own sandbox layer is active. But treat it as a degraded posture specific to whichever
pinned version needed it, not the design's default — log/flag it per deployment if triggered,
and drop back to `--ask-for-approval never` on the next CLI pin where the bug is confirmed
fixed.

### B.5 Model access — provider constraint + auth modes

- **`validateHarnessConfig`** (`packages/config/src/index.ts`) gets a `codex` branch mirroring
  the existing `claude-code` one: `harness: codex` requires every ref in `spec.models` to be
  `openai:*` — Codex speaks only OpenAI's API, so (§13.1) harness choice constrains provider
  choice here too. `AgentHarness` becomes `"pi" | "claude-code" | "codex"`; `HARNESSES` array
  updated; the model-and-cost design table (§13.1) gets a third row.
- **Direct key (bridge default)**, mirroring §4.1's direct-by-default decision for Claude Code:
  a Marathon-dedicated OpenAI key injected as `CODEX_API_KEY` at container launch; no proxy.
  Same rationale — on `network: bridge` a proxy adds no data boundary, since egress is already
  open; treat the key as a low-blast-radius spend credential.
- **ChatGPT-subscription auth (opt-in, dev-only)** — Codex CLI supports login via a ChatGPT
  account, mirroring Claude Code's OAuth-subscription mode (§4.1). Same fail-closed gate
  pattern: don't activate silently; require an explicit acknowledgement env var
  (`MARATHON_CODEX_SUBSCRIPTION_DEV=1`, mirroring `MARATHON_CLAUDE_SUBSCRIPTION_DEV`) until the
  credential-persistence behavior is confirmed safe for the host mount (*verify-on-pin* #4).
- **Proxy (locked-down egress)** — Claude Code's proxy relies on `ANTHROPIC_BASE_URL` being a
  documented, redirectable endpoint. Codex CLI's config reference documents the equivalent
  surface: `openai_base_url` overrides the base URL for the built-in OpenAI provider, and a
  custom `model_providers.<id>.base_url` entry (with `wire_api = "responses"`, plus `env_key`
  or `env_key_command` for auth) defines an arbitrary named provider. K8 should wire the
  Marathon key-injecting proxy through a custom `model_providers.marathon` entry (or
  `openai_base_url` if the built-in provider's shape is sufficient) the same way Claude Code
  uses `ANTHROPIC_BASE_URL`. `harness: codex` paired with `sandbox.network: none` does **not**
  need to fail closed by default on this basis anymore; confirm the exact `base_url`/
  `wire_api`/auth-field combination against the pinned CLI version (*verify-on-pin* #5) and
  only add a `network === "none"` guard for `codex` in `packages/github-app/src/build.ts` if
  that confirmation turns up a version-specific gap.

### B.6 Security lockdown — same shape as §12.6 Pattern 1

Everything in `claude-code-impl.md` §7 (network posture, phone-home lockdown, what is/isn't
the boundary) applies unchanged to Codex, with one substitution and one addition:

- Substitute `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for whatever Codex's equivalent
  telemetry/autoupdate-disable env var or config key is (*verify-on-pin* #6 — not found in the
  sources reviewed).
- Add: `--sandbox workspace-write` is passed on the primary path (§B.4) and stays enforced
  there, since `--ask-for-approval never` doesn't disable the CLI's own sandbox; on the
  `--yolo` fallback path it's still passed anyway — harmless if bypassed, free defense-in-depth
  if a future CLI version respects both flags together.
- Unchanged: read-only root, tmpfs scratch, cap-drop ALL, no-new-privileges, non-root uid,
  cpu/mem/pids limits, no business secrets forwarded (§12.6, `sandbox.ts:69`).

### B.7 Sessions, durability & resume

Mirror `claude-code-impl.md` §5 exactly, substituting Codex's session home. Claude Code sets
`CLAUDE_CONFIG_DIR=/workspace/.marathon-home/.claude` so sessions land host-visible and
diff-excluded; Codex's equivalent is `CODEX_HOME` (default `~/.codex`) — set
`CODEX_HOME=/workspace/.marathon-home/.codex` for the same three properties (host-visible,
diff-excluded, ephemeral-with-teardown). Exact on-disk session file layout under `CODEX_HOME`
is *verify-on-pin* #7 (needed to implement the per-turn snapshot-copy step, §11.2).

### B.8 `CodexAgentRuntime` — implementation sketch

New file `packages/agent/src/codex.ts`, third sibling of `pi.ts` and `claude-code.ts`, wired
into `runtime-factory.ts`'s `makeAgentRuntime` as a third branch (`spec.harness === "codex"`).
Same options shape as `ClaudeCodeAgentOptions` (secrets, sessionDir, sandbox container factory,
governed tools config, proxy, maxTurnsPerInvocation-equivalent watchdog, clarification,
cli overrides) — the two harnesses' options structs should very likely share a common base
type once both exist, since they differ only in a handful of fields (proxy env var name,
session home var name). Left to the BUILD phase to decide whether that's a shared
`SubprocessAgentRuntimeOptions` base or two parallel structs; not a design-level decision.

Unit-testable seams, mirroring both existing harnesses: pure `codexArgv(opts, checkpoint)`
builder; pure JSON-event-line reducer (`events → {progress, usage, result}`); shim MCP↔broker
bridging reused as-is (no new tests needed — same shim); snapshot/restore path logic.

**Wiring scope for this milestone: BUILD only**, matching K7's initial scope exactly — the
chat/general-agent surface has no code workspace and stays on Pi/Claude Code; general-chat
container binding for a third harness is a follow-on, not blocking here.

### B.9 Verify-on-pin checklist

Re-check against the pinned CLI version before K8 closes — several of these came from a
GitHub issue and a couple of doc pages, not an exhaustive spec, so treat this list as
mandatory pre-build homework, not optional polish:

1. Does `codex exec` have any per-invocation turn/step cap (a `--max-turns` equivalent)? If
   not, confirm the Marathon-side watchdog approach (§B.3) is sufficient.
2. Exact `turn.completed` JSON schema — does it carry token usage / cost fields, and are they
   per-invocation or cumulative across `resume`?
3. Confirm `--ask-for-approval never` + `default_tools_approval_mode = "approve"` (§B.4)
   actually pre-approves `marathon-mcp-shim` tool calls on the pinned CLI version, rather than
   auto-cancelling them; check the status of
   [openai/codex#24135](https://github.com/openai/codex/issues/24135) to see whether the
   auto-cancel bug it reported still reproduces, and fall back to `--yolo` only if it does.
4. Whether ChatGPT-subscription auth persists a token to a host-visible path under `CODEX_HOME`
   (parallel to Claude Code's `.credentials.json` question, `claude-code-impl.md` §4.1).
5. Confirm the exact `openai_base_url` / `model_providers.<id>.base_url` (+ `wire_api`,
   `env_key`/`env_key_command`) shape (§B.5) against the pinned CLI version, so the Marathon
   proxy config can be finalized.
6. Exact env var / config key to disable telemetry/autoupdate/phone-home traffic.
7. On-disk session/rollout file layout under `CODEX_HOME` (needed for the per-turn snapshot
   copy, §11.2).
8. Confirm `npm install -g @openai/codex@<pinned>` (or the current recommended install path) is
   the right toolchain-image line, and pin an exact version the same way `claude` is pinned
   (`claude-code-impl.md` §8.1).

### B.10 Tests & exit criteria (mirrors K7's shape)

- **Unit:** JSON-event reducer → `AgentTurn`/progress/usage mapping (incl. `turn.failed` →
  not-done, malformed lines); `codexArgv` builder (resume vs first turn, no secrets in argv);
  model access (`CODEX_API_KEY` injection, no key when proxy mode is wired instead via
  `model_providers.marathon`/`openai_base_url`); config cross-validation (`codex` + non-OpenAI
  model policy fails closed; `codex` + `network: none` fails closed only if pin-time
  verification turns up a proxy-config gap, §B.5).
- **`make demo-k8`:** a recorded/fake `codex` binary emitting a canned JSON-event script drives
  the same task pipeline through the real broker/gateway/container — same philosophy as
  `make demo-k7`.
- **Live smoke:** re-run the K1–K4 demos and `make demo-kernel` green with `harness=codex`.

---

## Rollout sequencing

Part A (event-scoped agent dispatch + stage-scoped model roles) is small, additive, and has no
external dependency — it can ship immediately, ahead of and independent from Part B. Part B
(Codex harness) is a K7-sized milestone (**K8**) gated on the verify-on-pin items in §B.9 —
most importantly confirming that `--ask-for-approval never` plus MCP pre-approval (§B.4)
actually works on the pinned CLI version, since that determines whether Codex ships with its
own sandbox active by default or needs the `--yolo` fallback — recommend confirming that
specifically before committing the rest of the build.

## Open questions / stated assumptions (flagging for review, not blocking on them)

- Event/role names `draft` / `review` / `build` / `revise` (§A.3) — easy to rename in review;
  no code depends on the literal strings beyond the four call sites listed.
- Multi-agent fan-out is in scope this pass only for `draft` (a comment/PR-creation event);
  `review` subscribes multiple agents but routes each event to a single owning agent per
  artifact rather than fanning out (§A.4 item 1); `build`/`revise` (code-writing events) keep
  single-agent dispatch with a first-registered-wins fallback and a warning if more than one
  spec subscribes (§A.4 item 3, §A.5) — full concurrent-writer support (branch-per-agent or
  serialized turns) is future work.
- Whether `on:` fan-out is scoped per-repo or globally across all deployments watching a repo —
  assumed per-repo (the natural scope of an `AgentSpec` registration); flagging as a stated
  assumption, not a decision.
- Field name `on:` vs `listensTo:` vs `events:` — bikeshed, no code depends on the literal key.
- Codex chat-surface (non-BUILD) support is out of scope for K8, matching K7's own initial
  scope (`claude-code-impl.md` §6: "chat/general-agent surface … stays on Pi").
- The BUILD step runner's per-task role resolution (§A.4 item 3) is the one wiring change
  that isn't a one-line swap; exact shape ("modelRef" becoming a function of the task) is left
  to BUILD, not fixed here.
