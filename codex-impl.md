# Codex headless harness (K8) + per-kernel-stage model routing

Answers a Slack ask (thread with `@forge`): run agents on **Codex CLI in headless mode** as
a third harness, and let a deployment pick a **different model for each kernel-loop stage** —
drafting the design plan, reviewing the plan PR, implementing the merged plan, and reviewing
the implementation PR.

These are two independent, additive changes to the same seam (`AgentRuntime` + the agent
YAML's `models:` policy), sequenced so the smaller one ships first. Part A has no dependency
on Part B and vice versa.

---

## Part A — Per-kernel-stage model routing

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
code-REVIEW pass a different (e.g. more careful/adversarial) model than BUILD itself.

### A.2 Decision: four canonical stage roles

Introduce four **reserved role names**, one per kernel stage, resolved via the existing
`resolveModelRef` at each call site instead of a flat default:

```yaml
models:
  default: openai:gpt-4o-mini   # required; fallback for any role not set below
  draft:   openai:gpt-4o        # drafting the design-doc PR
  review:  openai:gpt-4o        # revising the design doc from human review comments
  build:   openai:gpt-4o        # implementing the merged plan               (existing role)
  revise:  openai:gpt-4o        # revising the code PR from human review comments/mentions
```

No config-schema change: `AgentModelPolicy`/`ModelPolicy` are already open maps, so this is a
**naming convention**, not a new field. `forge.yaml` and `21-example-agents.md`'s Forge sample
get these four roles documented explicitly (today they show only `default`); an agent that
sets none of them keeps behaving exactly as it does today (everything resolves to `default`,
same as `build` does now when unset).

**Why these four and not, say, a fifth "self-review before requesting human review" role:**
the loop has no such step today — DRAFT hands straight to a human-reviewed PR, and BUILD hands
straight to a human-reviewed PR (§29.9: native review is the review surface for both). "review"
and "revise" name the *agent's own* response to that human review, which is the concrete,
already-existing work each does. Stated assumption, open to renaming in review — no code
depends on these four literal strings existing anywhere but the call sites below.

### A.3 Wiring changes

Four call sites change from a flat/shared model ref to a role-resolved one:

1. **`GithubAppDeps.modelRef`** (`packages/github-app/src/handlers.ts`) — replace the single
   `modelRef?: string` field with the agent's `AgentSpec.models` policy (already available
   wherever `GithubAppDeps` is constructed, since the spec is loaded there), and resolve:
   - `handleGithubMention` draft path → `resolveModelRef(models, "draft")`.
   - `handleGithubMention` revise path (existing artifact branch) → `resolveModelRef(models, "review")`.
   - `handleGithubReview` doc-PR branch → same `"review"` resolution (it calls into the mention
     handler's revise path already, so this falls out of the change above for free).
2. **`makeBuildWiring`** (`packages/github-app/src/build.ts`) — unchanged for fresh
   implementation (`"build"` role stays as-is).
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
4. **`validateHarnessConfig`** (`packages/config/src/index.ts`) — already iterates
   `Object.entries(spec.models)` generically for the `claude-code` Anthropic-only check, so the
   two new roles (`draft`, `review`, `revise` — `build` already covered) are validated for free;
   no change needed there.

### A.4 Non-goals (this pass)

- **Not** general per-step routing inside a single harness turn/session (§7.19's broader
  "classify_intent / plan_task / safety_check" vision stays open, unrelated to this ask).
- **Not** a new budget/cost dimension — `ModelInvocation` already records `provider`/`model`
  per call; per-role cost is answerable today from that + which call site ran (no new column).
  Attaching an explicit `role` tag to `ModelInvocation` for direct dashboard filtering is a
  reasonable small follow-up, not required to satisfy the ask.
- **Not** a fallback chain or constraint filter (§7.19 §Selection procedure steps 4–5) — out of
  scope; `resolveModelRef`'s existing default-fallback is all that's needed here.

### A.5 Risk / cost note

Splitting `review`/`revise` from `draft`/`build` lets an operator route the (usually shorter,
more surgical) review/revise turns to a cheaper model than the (usually longer, more
generative) draft/build turns, or vice versa — purely an operator choice; this doc does not
recommend a specific split.

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

### B.4 Governed tools over MCP — the one load-bearing risk

Codex attaches Marathon's governed tools exactly like Claude Code: `marathon-mcp-shim` as a
stdio MCP server in `config.toml`'s `[mcp_servers.marathon]`, forwarding every `tools/call` to
the host broker. **Reused verbatim — no new shim.**

**But headless MCP tool-call approval is currently broken upstream.** In `codex exec`
(non-interactive), MCP tool calls are auto-cancelled — stdin is closed so there's no one to
answer an approval prompt, and no documented config key suppresses it
([openai/codex#24135](https://github.com/openai/codex/issues/24135)). The only documented
workaround is `--dangerously-bypass-approvals-and-sandbox` (`--yolo`), which also disables the
CLI's **own** sandbox policy.

This is the same trade Claude Code already made with `--permission-mode bypassPermissions`
(`claude-code-impl.md` §3.3: "the harness's own permission machinery is defense-in-depth, never
the security boundary — containment (the container) and the gateway (host-side) are the
boundary"). The identical argument covers Codex: Marathon's Docker container is the file/process
boundary, and `ToolGateway.run` is the effect boundary, regardless of whether the CLI's *own*
sandbox layer is active. So `--yolo` is safe to pass **because** the container still contains
it — same reasoning, not a new exception.

What's different from Claude Code, and must be stated as an accepted risk rather than glossed
over: Claude Code's `bypassPermissions` is a documented, intended flag for exactly this use
case; Codex's `--dangerously-bypass-approvals-and-sandbox` is explicitly named to discourage
non-`--yolo`-audited use, and the upstream issue is open, meaning the maintainers consider this
a gap, not a feature. **Ship gated on containment being airtight** (no network egress path that
bypasses the broker; `--sandbox` flag passed anyway as defense-in-depth even though bypassed,
so a future fix that respects it costs nothing) and revisit if/when upstream ships a proper
non-interactive MCP-approval config key (*verify-on-pin* #3).

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
  documented, redirectable endpoint. Whether Codex CLI honors an equivalent base-URL override
  for the OpenAI API is **not confirmed** in the sources reviewed here — *verify-on-pin* #5.
  Until confirmed, `harness: codex` paired with `sandbox.network: none` should **fail closed**
  at BUILD wiring, exactly like `claude-code` does today for the same posture
  (`packages/github-app/src/build.ts`'s existing `network === "none"` guard gets a `codex` arm
  with the same refusal message).

### B.6 Security lockdown — same shape as §12.6 Pattern 1

Everything in `claude-code-impl.md` §7 (network posture, phone-home lockdown, what is/isn't
the boundary) applies unchanged to Codex, with one substitution and one addition:

- Substitute `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for whatever Codex's equivalent
  telemetry/autoupdate-disable env var or config key is (*verify-on-pin* #6 — not found in the
  sources reviewed).
- Add: `--sandbox workspace-write` is passed even though `--yolo` bypasses it (§B.4) — free
  defense-in-depth if a future CLI version respects both flags together, harmless if not.
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
3. Status of [openai/codex#24135](https://github.com/openai/codex/issues/24135) (headless MCP
   approval) at pin time — does a non-`--yolo` path exist yet?
4. Whether ChatGPT-subscription auth persists a token to a host-visible path under `CODEX_HOME`
   (parallel to Claude Code's `.credentials.json` question, `claude-code-impl.md` §4.1).
5. Whether Codex CLI supports a redirectable API base URL for a key-injecting proxy under
   locked-down egress.
6. Exact env var / config key to disable telemetry/autoupdate/phone-home traffic.
7. On-disk session/rollout file layout under `CODEX_HOME` (needed for the per-turn snapshot
   copy, §11.2).
8. Confirm `npm install -g @openai/codex@<pinned>` (or the current recommended install path) is
   the right toolchain-image line, and pin an exact version the same way `claude` is pinned
   (`claude-code-impl.md` §8.1).

### B.10 Tests & exit criteria (mirrors K7's shape)

- **Unit:** JSON-event reducer → `AgentTurn`/progress/usage mapping (incl. `turn.failed` →
  not-done, malformed lines); `codexArgv` builder (resume vs first turn, no secrets in argv);
  model access (`CODEX_API_KEY` injection, no key when proxy mode is wired instead); config
  cross-validation (`codex` + non-OpenAI model policy fails closed; `codex` + `network: none`
  without confirmed proxy support fails closed, §B.5).
- **`make demo-k8`:** a recorded/fake `codex` binary emitting a canned JSON-event script drives
  the same task pipeline through the real broker/gateway/container — same philosophy as
  `make demo-k7`.
- **Live smoke:** re-run the K1–K4 demos and `make demo-kernel` green with `harness=codex`.

---

## Rollout sequencing

Part A (stage-scoped model roles) is small, additive, and has no external dependency — it can
ship immediately, ahead of and independent from Part B. Part B (Codex harness) is a
K7-sized milestone (**K8**) gated on the verify-on-pin items in §B.9, most importantly the
open headless-MCP-approval issue (§B.4) — recommend a spike on that specifically before
committing the rest of the build.

## Open questions / stated assumptions (flagging for review, not blocking on them)

- Role names `draft` / `review` / `build` / `revise` (§A.2) — easy to rename in review; no
  code depends on the literal strings beyond the four call sites listed.
- Codex chat-surface (non-BUILD) support is out of scope for K8, matching K7's own initial
  scope (`claude-code-impl.md` §6: "chat/general-agent surface … stays on Pi").
- The BUILD step runner's per-task role resolution (§A.3 item 3) is the one wiring change
  that isn't a one-line swap; exact shape ("modelRef" becoming a function of the task) is left
  to BUILD, not fixed here.
