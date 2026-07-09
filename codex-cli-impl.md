# Codex CLI Harness — Implementation Guide for Marathon (K8)

The integration reference for the **Codex CLI (headless) harness** — the third `AgentRuntime`
behind the seam (design §7.5), the way `pi-details.md` is the reference for Pi and
`claude-code-impl.md` for Claude Code. It covers what `codex exec` gives us headless, how each
piece maps onto Marathon's existing seams (with file:line pointers into this repo), the
hardened security shape (design §12.6 Pattern 1), and the build plan.

> **Predecessor.** This doc supersedes and expands **`codex-impl.md` Part B** (the K8 design
> sketch merged with the Part-A dispatch work). Part B was written against the K7 *design*;
> this doc is written against the K7 *as-built* code, and several of Part B's premises have
> moved — most importantly the checkpoint-cadence framing (§2.1 below: Claude Code 2.x removed
> `--max-turns`, so whole-invocation turns are already the accepted contract, not a
> Codex-specific gap) and the broker transport (TCP + capability token landed for macOS
> Docker Desktop, §3.1). Where the two disagree, this doc wins.

> **Source & version.** CLI behavior verified against the official Codex docs
> (developers.openai.com/codex, July 2026). Codex CLI ships fast — **pin an exact CLI version
> in the sandbox toolchain image** (§8.1) and re-verify the items marked *verify-on-pin* (§10)
> against that version before relying on them; a couple of the claims below trace to a GitHub
> issue rather than the reference docs.

---

## 1. What Codex headless is

- **Codex CLI** (`@openai/codex`) is OpenAI's open-source coding-agent CLI. Non-interactive
  automation runs through **`codex exec`**: no TUI, prompt in, agent loop (model calls + tool
  calls) until done, structured events out, process exits — the same shape as `claude -p`.
- `codex exec "<prompt>" --json` streams newline-delimited JSON events on stdout and prints
  only the final agent message. Event types: `thread.started`, `turn.started` /
  `turn.completed` / `turn.failed`, `item.started` / `item.completed` (covering agent
  messages, reasoning, command execution, file changes, **MCP tool calls**, web searches,
  plan updates).
- `codex exec resume <SESSION_ID>` (or `--last`) continues a prior non-interactive run — the
  resume primitive the §11.2 checkpoint contract needs.
- `--sandbox {read-only|workspace-write|danger-full-access}` is the CLI's **own** sandbox
  policy for model-generated commands — defense-in-depth only, never Marathon's boundary
  (§3.3, same reasoning as Claude Code's `--permission-mode`).
- `--model` selects the model; `--cd` sets the workspace root; `-c key=value` overrides
  `config.toml` entries; `--ephemeral` skips persisting session files (Marathon does **not**
  want this — durable, resumable sessions are the point).
- External tools attach over **MCP**, configured in `config.toml`
  (`[mcp_servers.<name>]`, stdio or HTTP transport) — this is how Marathon's governed tools
  arrive (§3).
- **Codex calls the model itself and only speaks OpenAI's API** — the harness choice pins the
  provider (design §13.1), exactly as Claude Code pins Anthropic. The endpoint is
  redirectable via `openai_base_url` / `model_providers.<id>.base_url` in `config.toml`,
  which is what makes a key-injecting proxy possible later (§4.1).
- Auth: saved CLI credentials (a ChatGPT-account login) by default, or an explicit
  `CODEX_API_KEY` env var per invocation.

Sources: [Non-interactive mode](https://developers.openai.com/codex/noninteractive) ·
[CLI reference](https://developers.openai.com/codex/cli/reference) ·
[Config reference](https://developers.openai.com/codex/config-reference).

**Marathon fit:** Codex is a second instance of the **Pattern 1** shape (design §12.6) that
`claude-code-impl.md` §1 already generalized: the whole agent loop runs *inside* the sandbox
container as a subprocess; file/bash tools are contained by construction (they see only
`/workspace`); governed tools are brokered back to the host over MCP; the model call exits
only through host-controlled auth. Nothing here is Codex-specific enough to need a new
isolation pattern — it reuses `marathon-mcp-shim`, `serveToolBroker`, and `ToolGateway.run`
exactly as Claude Code does.

```text
        HOST (trusted)                          │   SANDBOX CONTAINER (untrusted)
                                                │
  CodexAgentRuntime.nextTurn()                  │
    └─ docker exec: codex exec --json           │   codex CLI (pinned)
         [resume <sid> |] "<prompt>"    ───────┼──►  agent loop
    ◄── JSONL events on stdout ─────────────────┼───  --sandbox workspace-write → /workspace only
                                                │       │
  serveToolBroker (unix socket │ TCP+token) ◄───┼─── marathon-mcp-shim (same shim as Claude
    └─ ToolGateway.run (validate → policy →     │        Code — Codex is just another MCP
       ledger → egress → creds → execute →      │        client; §3.1)
       redact → audit)                          │
                                                │
  model access (§4.1):                          │
    bridge default → direct CODEX_API_KEY ──────┼──► OpenAI  (no proxy)
    locked-down → key-injecting proxy ◄─────────┼─── openai_base_url override (deferred; §4.1)
```

---

## 2. How Marathon runs it — the turn model

### 2.1 One harness turn = one `codex exec` invocation

The `AgentRuntime` seam is a single method — `nextTurn(ctx): Promise<AgentTurn>`
(`packages/agent/src/types.ts:109`). For Codex:

- **A harness turn is one `codex exec` invocation.** First turn:
  `codex exec --json "<prompt>" …`; every later turn:
  `codex exec --json resume <session-id> "<prompt>" …`. The CLI's internal model→tool cycles
  happen inside one invocation.
- **Checkpoint cadence: whole-invocation granularity — the same as-built contract K7 landed
  on.** `codex-impl.md` §B.3 treated Codex's missing `--max-turns` equivalent as a gap to
  route around, on the premise that Claude Code bounds its invocations. That premise is
  stale: **Claude Code 2.x removed `--max-turns`**, and the as-built K7 runtime checkpoints
  at the invocation's result event (`maxTurnsPerInvocation` is retained-but-ignored,
  `packages/agent/src/claude-code.ts:104`; turn atomicity holds per §11.2 — a killed
  invocation reruns from the last snapshot). Codex is therefore **not** a degraded posture:
  both subprocess harnesses run one full agentic loop per turn.
  **Optional hardening (both harnesses, one knob):** a Marathon-side wall-clock watchdog
  that SIGTERMs a runaway invocation and fails the turn under the §11.2 mid-turn rule —
  worth building once, harness-agnostic, config-keyed; not a K8 blocker
  (*verify-on-pin* #1 first checks whether the pinned CLI grew a native cap).
- The invocation runs **inside the task's container** via the same `AgentContainer` seam
  Claude Code uses (`packages/agent/src/claude-code.ts:40`), owned by `nextTurn` exactly as
  both existing harnesses own theirs.

### 2.2 Mapping onto `AgentTurn`

| `AgentTurn` field (`types.ts:67`) | Codex JSON-event source |
| --- | --- |
| `text` | the final agent-message `item` on `turn.completed` |
| `modelInvocation` | usage/cost fields on `turn.completed` — **schema unconfirmed, verify-on-pin #2** (§4.3) |
| `done` | `turn.completed` **and** no pending `ask_user` (§2.3); `turn.failed` ⇒ `done: false` (checkpoint, retry — the analog of K7's `error_max_turns`/`is_error` handling) |
| `waiting` | set when the run ended after an `ask_user` MCP call (§2.3) |
| `sessionRef` | the Codex session id + the turn-snapshot path (§5.2), encoded via the same `SessionRef` shape (`claude-code.ts:148` — lift to a shared module or duplicate; BUILD's call) |
| `turnIndex` | Marathon's own counter from `checkpoint`, same as both existing harnesses |

One asymmetry vs Claude Code: `claude -p --session-id <uuid>` **pins** the session id before
the process runs, so `sessionRef` is known up front. Codex appears to *mint* its id and
report it via `thread.started` — so the runtime captures the id from the **first streamed
event** and must treat "process died before `thread.started`" as a fresh-start retry
(no session to resume). Whether an id can be supplied up front is *verify-on-pin* #8.

### 2.3 Clarifying questions (`waiting`)

Same shim-level convention as Claude Code (`claude-code-impl.md` §2.3): `ask_user` is a
governed MCP tool; the broker records the question and returns "question recorded — end your
response now and wait for the answer"; the runtime sees the recorded question after the
invocation completes and returns `waiting: { question }` (§11.6 async shape). The answer
arrives as the next turn's prompt over `resume`. No mid-turn suspend.

### 2.4 System prompt and input

- `AgentRequest.instructions` (the persona from the agent YAML, `types.ts:19`): Codex has no
  `--append-system-prompt` flag, but the config surface has exactly the appending mechanism
  we want. **Decision: `developer_instructions` in the per-turn `config.toml` is the default
  mechanism** — it *adds* developer-level instructions alongside Codex's built-in system
  prompt, which is the `--append-system-prompt` analog. Do **not** use `instructions` (a
  reserved key) or `model_instructions_file` (it *replaces* the built-in instructions
  wholesale, which would strip the CLI's own tool-use behavior — the same reason K7 appends
  rather than replaces). And never a workspace `AGENTS.md`: the workspace is agent-writable,
  and the repo under work may carry its *own* `AGENTS.md` (untrusted content, §7.18) that
  must not be confused with Marathon's persona. Confirm `developer_instructions` semantics
  on the pinned version (*verify-on-pin* #9); the fallback — kept unit-tested, never the
  default — is prepending the instructions to the `-p` prompt (same trust layer, less clean).
- `AgentRequest.input` is the positional prompt. Untrusted surface content stays fenced
  inside it (`<<<UNTRUSTED>>>` markers, §7.18) — identical to both existing harnesses; the
  trust hierarchy is prompt-construction, not harness machinery.

---

## 3. Governed tools over MCP (reused verbatim)

### 3.1 The shape: the same shim, a different config file

Marathon's governed tools are served to Codex as **one MCP server backed by `gateway.run`**,
through exactly the machinery K7 built:

- **`marathon-mcp-shim`** (`packages/mcp-shim/src/` — `bin.ts`, `handler.ts`,
  `connect.ts:8`) is a generic stdio MCP server: `initialize`, `tools/list`, `tools/call`,
  forwarded to the host-side `serveToolBroker` (`packages/tools/src/broker-transport.ts:29`)
  backed by `handleToolRequest` (`packages/tools/src/broker.ts:25`). Nothing in it is
  Claude-specific — **Codex is just another MCP client. No new shim.**
- **Both transports carry over:** per-task **unix socket** mounted at
  `/run/marathon/broker.sock` (the Linux default), or **TCP to
  `host.docker.internal:<port>`** with the per-turn **capability token** (`--tcp`/`--token`)
  on macOS Docker Desktop, where a bind-mounted socket is unconnectable (ENOTSUP) — the
  as-built `brokerHost` mechanism (`claude-code.ts:116`), verified end-to-end in K7.
- What differs is only **where the MCP config lives**. Claude Code takes
  `--mcp-config <file> --strict-mcp-config`; Codex reads `config.toml` under `CODEX_HOME`:

  ```toml
  # $CODEX_HOME/config.toml — atomically rewritten by the runtime before every invocation
  [mcp_servers.marathon]
  command = "marathon-mcp-shim"
  args = ["--socket", "/run/marathon/broker.sock"]   # or ["--tcp", "host:port", "--token", "<t>"]
  default_tools_approval_mode = "approve"
  required = true            # fail the invocation if the shim can't initialize — never run
                             #   BUILD without governed tools (§4.2); fail-closed by config,
                             #   not by stream-parsing heuristics
  startup_timeout_sec = 20   # bound the shim/broker handshake so a wedged broker fails the
                             #   turn fast instead of hanging the invocation

  [projects."/workspace"]
  trust_level = "untrusted"  # pin the workspace untrusted so no repo-local .codex/ layer
                             #   (config, hooks, rules) is ever loaded from the checkout
  ```

  The runtime **atomically rewrites `$CODEX_HOME/config.toml` per turn** (write-temp +
  rename; the analog of `mcpConfigJson`, `claude-code.ts:215`), so a crashed or tampered
  previous *config* never leaks into the next invocation. **Config only — never the rest of
  `CODEX_HOME`:** the resumable session/rollout state lives under the same tree (§5), so a
  whole-tree rewrite would delete the very state `codex exec resume` needs. Config and state
  share the home but have opposite lifecycles: config is disposable per turn, state is the
  checkpoint.

  There is no `--strict-mcp-config` equivalent, and Codex's project-trust model means a
  *trusted* project can load project-scoped `.codex/` layers from the checkout — an
  untrusted workspace must never earn that. The mitigations, in order: (a) the explicit
  `[projects."/workspace"] trust_level = "untrusted"` pin above, written every turn;
  (b) a unit/demo probe asserting a planted repo-local `.codex/config.toml` (plus hooks and
  rules files) does **not** load — a rogue MCP server or hook planted in the checkout never
  runs (§9); (c) *verify-on-pin* #10 — confirm on the pinned CLI that the untrusted trust
  level suppresses every project-scoped config layer; and (d) as always, containment + the
  gateway are the boundary regardless (§7.3).

### 3.2 What the gateway pipeline preserves

`ToolGateway.run` (`packages/tools/src/gateway.ts:118`) is unchanged: validate → policy →
egress route vs the source ledger → credential-injected execute → redact → audit. Broker
responses are **redacted before they cross back**, so tool results enter the container — and
therefore Codex's session files — already clean. `requires_proposal` outcomes surface as
typed refusals. Gateway-side `ToolInvocation` rows remain the source of truth; the JSON
event stream only powers progress and the timeline (§4.2). Tool naming: the shim lists the
same sanitized names (`github_read_file`) it lists to Claude Code; whatever prefix Codex
applies to MCP tool names is cosmetic to the model and invisible to the broker.

### 3.3 Approval mode + constraining the built-ins

The CLI's own permission machinery is **defense-in-depth, never the security boundary** —
containment (the container) and the gateway (host-side) are the boundary (design §12).

- **Default: `--ask-for-approval never` with the Marathon MCP server pre-approved**
  (`default_tools_approval_mode = "approve"` on `[mcp_servers.marathon]`, or per-tool
  `approval_mode` entries) — headless runs can't answer prompts, and this keeps
  `--sandbox workspace-write` active as real defense-in-depth. No `--yolo` on the happy path.
- **Fallback, not default: `--yolo`** (`--dangerously-bypass-approvals-and-sandbox`) **iff**
  the pinned CLI reproduces the auto-cancel bug
  ([openai/codex#24135](https://github.com/openai/codex/issues/24135): earlier builds
  auto-cancelled MCP tool calls in non-interactive mode regardless of approval config).
  *Verify-on-pin* #3 is the gate. The same argument K7 already relies on for
  `--permission-mode bypassPermissions` covers this: the container is the file/process
  boundary and `ToolGateway.run` the effect boundary either way. But treat `--yolo` as a
  degraded, version-specific posture — log it per deployment, drop it on the next pin where
  the bug is fixed.
- **`--sandbox workspace-write`** on the primary path (harmless-if-bypassed on the fallback
  path). Codex's `--sandbox read-only` maps naturally onto the `readOnly` option K7 grew for
  grounded chat (`claude-code.ts:124`) — noted for the chat follow-on (§6), out of K8 scope.
- Web search: Codex has a built-in web-search capability whose execution side
  (server-side via the API vs client-side fetch) determines its posture under locked-down
  egress, exactly as `WebSearch` vs `WebFetch` did for Claude Code — *verify-on-pin* #11.
  Under the kernel-default `bridge` posture it can stay enabled either way.

---

## 4. Models, auth & cost

### 4.1 Model access — direct key by default; proxy deferred to the locked-down follow-on

Mirror the **2026-07-07 K7 decision** (`claude-code-impl.md` §4.1) mode-for-mode; the
rationale transfers unchanged because it was about the *network posture*, not the provider:

- **Direct (default on `network: bridge`).** A Marathon-dedicated OpenAI key from the secret
  store (`secret/openai-codex` — a *separate, spend-capped* key, not the Pi/model-gateway
  key) injected at container launch as `CODEX_API_KEY`; no base-URL override, no proxy. On
  bridge the sandbox already has open outbound, so a proxy adds no data boundary; the key is
  a low-blast-radius **spend** credential (provider-budget-capped, rotated). Business
  credentials (GitHub/Slack/document) stay brokered host-side in every posture — that is the
  boundary that matters.
- **ChatGPT-subscription auth (opt-in, dev-only).** Codex supports a ChatGPT-account login,
  mirroring Claude Code's subscription mode. Same fail-closed gate: it does **not** activate
  silently — require `MARATHON_CODEX_SUBSCRIPTION_DEV=1` (mirroring
  `MARATHON_CLAUDE_SUBSCRIPTION_DEV` and `assertSubscriptionAckIfNeeded`,
  `claude-code.ts:265`/`277`) until credential-persistence behavior under `CODEX_HOME` is
  confirmed safe for the host-visible mount (*verify-on-pin* #4). Under subscription the USD
  budget is inert (skip the mid-invocation kill; rate limits + the watchdog bound runaways) —
  same as K7.
- **Proxy (locked-down egress) — deferred, fail closed until built.** The CLI-side surface
  is documented (`openai_base_url` for the built-in provider, or a
  `model_providers.marathon` entry with `base_url` + `wire_api = "responses"` +
  `env_key`); the Marathon-side piece — an OpenAI-flavored generalization of
  `AnthropicKeyProxy` (`packages/model-gateway/src/proxy.ts`) with an `api.openai.com` path
  allowlist — is **not built and not needed for the kernel default**. K8 therefore ships the
  same fail-closed gate K7 shipped: `harness: codex` + `sandbox.network: none` **refuses to
  wire** (the exact pattern at `packages/github-app/src/build.ts:196`), until a locked-down
  deployment funds the proxy work. This sharpens `codex-impl.md` §B.5, which made the guard
  conditional on pin-time findings — the guard is unconditional until the proxy *component*
  exists, whatever the CLI supports.

The **`resolveModelAccessEnv` analog** (`claude-code.ts:345`) carries over: a pure function
resolving posture → env, failing closed on direct-without-key and locked-down-without-proxy,
unit-asserted to never place a real key in argv or, in proxy mode, in the container env.

### 4.2 Event stream → Marathon records

`codex exec --json` emits one JSON object per line:

| Event | Marathon mapping |
| --- | --- |
| `thread.started` | session id capture (§2.2); log it. A missing/failed `marathon` MCP mount **fails the invocation itself** — `required = true` + `startup_timeout_sec` (§3.1) make "never run BUILD without governed tools" a config-enforced startup failure, not a stream-parsing heuristic; the runtime maps that startup failure to a failed turn (how it surfaces — exit code vs `turn.failed` — is *verify-on-pin* #12) |
| `item.started` / `item.completed` (command, file change, MCP call, web search) | `onEvent {type:"tool_start"/"tool_end"}` progress (`AgentProgressEvent`, `types.ts:60`), summaries size-capped |
| `item.completed` (agent message) | streamed text progress |
| `turn.completed` | turn end: final text, usage/cost → `ModelInvocationData` (`types.ts:4`), done-ness (§2.2) |
| `turn.failed` | not-done: checkpoint and let the step runner retry from the snapshot |

A pure line reducer — `codex-stream.ts`, sibling of `claude-stream.ts`
(`parseStreamJsonLine` / accumulator / `interpretResult`,
`packages/agent/src/claude-stream.ts:52,68,175`) — is the unit-test surface: malformed lines
skipped, `turn.failed` → not-done, id capture, usage accumulation.

### 4.3 Cost capture and budget enforcement

- Per harness turn, build `ModelInvocationData` from `turn.completed`'s usage fields,
  reported through `onTurnCheckpoint` exactly like both existing harnesses. Whether the
  numbers are per-invocation or **cumulative across `resume`** is *verify-on-pin* #2 — if
  cumulative, record the delta against the previous checkpoint (the same question K7 carried
  for `total_cost_usd`).
- **Between-turn budgets work unchanged** (`assertWithinBudget`,
  `packages/worker/src/agent-step.ts`). The **mid-invocation kill** K7 does from streamed
  per-message usage (`getRemainingBudgetUsd`, `claude-code.ts:144`) depends on whether
  Codex's stream carries usage *before* `turn.completed` — if it doesn't (*verify-on-pin*
  #2), the wall-clock watchdog (§2.1) plus between-turn checks are the interim bound, stated
  as an accepted limitation in the agent YAML docs.
- **Model selection:** `modelRef` is `"provider:model"`; the runtime passes the model id via
  `--model`. **`provider` must be `openai`** — `validateHarnessConfig`
  (`packages/config/src/index.ts:512`) grows a `codex` branch mirroring the `claude-code`
  Anthropic-only branch; `AgentHarness` (`config/src/index.ts:152`) becomes
  `"pi" | "claude-code" | "codex"`; `HARNESSES` (`:261`) updated; design §13.1's table gets
  a third row. Because Part A's per-stage roles already iterate `spec.models` generically,
  every kernel role (`draft`/`design-review`/`build`/`code-review`) is validated for free.

---

## 5. Sessions, durability & resume

### 5.1 Where the session lives — inside the workspace home

Mirror K7 §5.1, substituting the session home. The toolchain image already sets
`HOME=/workspace/.marathon-home` (`docker/sandbox/Dockerfile`); set
**`CODEX_HOME=/workspace/.marathon-home/.codex`** (default `~/.codex`) and the whole
session/config story lands there by construction, with the same three properties:

- **Host-visible** — the runtime persists/snapshots session files without `docker cp`
  (the analog of `claudeSessionHostPath`, `claude-code.ts:239`).
- **Diff-excluded** — the workspace manager already excludes `.marathon-home` from the repo's
  git view, so the trace can never ride the §29.4 diff into a PR.
- **Ephemeral** — teardown destroys it; the durable copies are Marathon's snapshots (§5.2).
  Tool results inside it are broker-pre-redacted (§3.2); in direct mode the key lives only in
  the process env, not the session files (assert this in a unit probe; *verify-on-pin* #4
  covers the subscription-token case).

The exact on-disk session/rollout layout under `CODEX_HOME` is *verify-on-pin* #7 — needed to
implement the snapshot copy.

### 5.2 Checkpoint/resume (K4 contract, design §11.2)

Identical contract, third implementation:

- **After each completed invocation**, copy the live session file(s) to
  `sessionDir/<taskId>/turn-<N>` (host-side) and emit
  `onTurnCheckpoint { turnIndex, sessionRef: { sessionId, snapshot }, modelInvocation }` —
  reusing the `SessionRef` encode/decode shape (`claude-code.ts:148–169`).
- **Resume** (`checkpoint.sessionRef` present): fresh container, re-materialized workspace
  (clone at `base_sha` + replay the checkpointed diff), **restore the snapshot over any
  partial state** under `CODEX_HOME`, then `codex exec --json resume <sessionId> "<prompt>"`.
  Restoring over a crashed invocation's leavings is what "discard the incomplete turn and
  replay" means here — unchanged.
- **Containers are never recovered**; re-executed governed calls converge on idempotency
  keys (§11.3); the handoff converges on `(task_id, tree_hash)` (§29.4). Do **not** pass
  `--ephemeral` (it would disable the session persistence this contract depends on).

---

## 6. `CodexAgentRuntime` — implementation sketch

New files `packages/agent/src/codex.ts` + `codex-stream.ts`, third siblings of
`pi.ts`/`claude-code.ts` and `claude-stream.ts`, wired as a third branch in
`makeAgentRuntime` (`packages/agent/src/runtime-factory.ts:50`), which fails closed exactly
as the `claude-code` branch does (validate harness/model pairing, require the sandbox
container factory).

```ts
export interface CodexAgentOptions {
  secrets: SecretStore;                    // host-side; CODEX_API_KEY injected in direct mode (§4.1)
  registry?: ModelRegistry;
  sessionDir?: string;                     // per-task snapshots (§5.2)
  sandbox: { createContainer(req, workspace, extra?): AgentContainer };  // REQUIRED — no host mode
  governed?: GovernedToolsConfig;          // same spec list; served via broker + shim (§3.1)
  clarification?: boolean;                 // ask_user over MCP (§2.3)
  lockedDownEgress?: boolean;              // network:none — fail closed until the OpenAI proxy exists (§4.1)
  brokerHost?: string;                     // TCP broker for macOS Docker Desktop (§3.1)
  readOnly?: boolean;                      // chat follow-on: maps to --sandbox read-only (§3.3)
  maxWallClockMsPerInvocation?: number;    // the §2.1 watchdog (optional hardening)
  cli?: { bin?: string; shimCommand?: string; shimArgs?: string[] };
  socketDir?: string;
  getRemainingBudgetUsd?: (ctx) => …;      // effective only if the stream carries usage (§4.3)
}
```

The options struct deliberately mirrors `ClaudeCodeAgentOptions` (`claude-code.ts:65`) —
they differ in a handful of fields (env var names, session home, config-file mechanism).
Whether that becomes a shared `SubprocessAgentRuntimeOptions` base or two parallel structs is
a BUILD-phase call, not a design decision (unchanged from `codex-impl.md` §B.8).

`nextTurn` skeleton = `ClaudeCodeAgentRuntime.nextTurn` (`claude-code.ts:372`) step for step:
resolve model-access env fail-closed **first** → container + workspace up, broker served
(socket or TCP+token) → restore snapshot if resuming → **atomically rewrite
`CODEX_HOME/config.toml`** (the one step Claude Code doesn't have; §3.1 — MCP server with
`required = true`, `developer_instructions` persona (§2.4), the untrusted-project pin;
config only, never the session state beside it) → spawn
`codex exec --json [resume <sid>] "<prompt>" --sandbox workspace-write --ask-for-approval
never --model <id> --cd /workspace` → reduce the event stream (progress, id capture, usage)
→ on `turn.completed`: snapshot → `onTurnCheckpoint` → `AgentTurn` → finally container stop.
Pure, unit-testable seams: `codexArgv(opts, checkpoint)` (no secrets in argv),
`codexConfigToml(...)` (the config writer), the stream reducer, snapshot/restore paths.

**Wiring scope for K8: BUILD only** (`packages/github-app/src/build.ts:204`), matching K7's
*initial* scope. Note K7 has since expanded to the **chat surfaces** via `withChatWorkspace`
(`packages/agent/src/chat-workspace.ts`, §2b #17) — so the chat follow-on for Codex is a
small, known step (the seam exists; `readOnly` maps to `--sandbox read-only`), just not this
milestone. The worker step runners need **no changes** — the seam holds.

---

## 7. Security lockdown (design §12.6 Pattern 1)

Everything in `claude-code-impl.md` §7 applies unchanged, with one substitution and two notes:

- **Network postures (§7.1):** identical — `bridge` (kernel default; direct spend key,
  §4.1) or the internal-only network for locked-down deployments (which for Codex **fails
  closed until the OpenAI proxy component exists**, §4.1). The invariant in both:
  **business-credential-freedom** — no GitHub/Slack/document credential ever enters the
  container; the broker stays a unix-socket mount / token-guarded TCP endpoint, never an
  open port.
- **Phone-home lockdown (§7.2):** substitute Claude Code's
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` with Codex's telemetry/autoupdate-disable
  mechanism — **not found in the docs reviewed**; *verify-on-pin* #6. Whatever it is, the
  goal is the same: the model API is the CLI's only required network dependency, quietly.
- **Boundary (§7.3):** unchanged verbatim. Codex's `--sandbox` policy and approval modes are
  defense-in-depth; the container, the broker + gateway, and branch protection are the
  boundary. Injection posture unchanged: untrusted content fenced in the prompt, session
  files broker-redacted by construction, the plan doc arrives as workspace files (§29.2).
- `hardeningFlags` (`packages/tools/src/sandbox.ts:69`) unchanged: read-only root, tmpfs
  scratch, cap-drop ALL, no-new-privileges, non-root uid, cpu/mem/pids limits.

---

## 8. Toolchain image & config

### 8.1 Image additions (`docker/sandbox/Dockerfile`)

- `npm install -g @openai/codex@${CODEX_VERSION}` — exact-version pin next to the existing
  `CLAUDE_CODE_VERSION` pin; bump `SANDBOX_VERSION` and add `codex: $(codex --version)` to
  the toolchain manifest so drift is observable (Track 11). Confirm npm is still the
  recommended install path at pin time (*verify-on-pin* #5).
- Nothing else: the shim is already in the image (K7), and Codex's config is written per-turn
  into the workspace home, not baked in.

### 8.2 Agent YAML (§6.2)

```yaml
name: forge
harness: codex            # third value; validated at load
models:
  default: openai:gpt-5-codex     # every ref must be openai:* (fails closed, §4.3)
  draft:   openai:gpt-5
sandbox:
  network: bridge          # `none` fails closed for codex until the proxy lands (§4.1)
```

Load-time cross-validation lands in `validateHarnessConfig`
(`packages/config/src/index.ts:512`) as described in §4.3. Part A's `on:` dispatch and
per-stage model roles compose with this orthogonally — a deployment can already point
`draft` at one OpenAI model and `build` at another; K8 adds nothing there.

---

## 9. Tests & demos (K8 exit criteria)

Mirrors K7's shape (`claude-code-impl.md` §9):

- **Unit:** `codex-stream.ts` reducer → `AgentTurn`/progress/usage mapping (incl.
  `turn.failed` → not-done, malformed lines, session-id capture, died-before-
  `thread.started`); `codexArgv` builder (resume vs first turn, **no secrets in argv**);
  `codexConfigToml` writer (shim entry, approval mode, socket vs TCP+token, **`required =
  true` + `startup_timeout_sec` present**, `developer_instructions` carries the persona,
  **`[projects."/workspace"] trust_level = "untrusted"` present**) and its atomic-rewrite
  path leaving session state untouched (§3.1); the prompt-prepend persona fallback (§2.4);
  model access (direct injects `CODEX_API_KEY`; locked-down fails closed; subscription
  requires the ack env); snapshot/restore incl. restore-over-partial; config
  cross-validation (`codex` + non-OpenAI policy fails closed; `codex` + `network: none`
  fails closed at the BUILD wiring). Shim/broker bridging needs **no new tests** — same
  shim, already covered.
- **Live probes (pin-time, kept as tests where automatable):** a broken/absent shim command
  with `required = true` fails the invocation (never a silent governed-tool-less run, §4.2);
  a **planted repo-local `.codex/config.toml`, hook, and rules file** in the workspace does
  **not** load under the untrusted-project pin (§3.1) — the rogue MCP server it declares
  must never appear in `tools/list`.
- **`make demo-k8`** (`demos/k8/`, CI job): a **fake `codex` binary** emitting a canned
  JSON-event script (injected via `cli.bin`, exactly like `demo-k7`'s stub) drives the full
  pipeline with the **real** broker, gateway, and container: threaded reply, governed calls
  audited, cost captured, kill-and-resume mid-run. Deterministic, no network, no key.
- **Live smoke + the real bar:** re-run the K1–K4 demos and **`make demo-kernel` green with
  `harness=codex`** — identical loop behavior on any harness is what "harnesses are
  replaceable" (design §28 organ #1) means with three of them.

---

## 10. Verify-on-pin checklist

Mandatory pre-build homework against the pinned CLI version — several items trace to one
GitHub issue and two doc pages, not an exhaustive spec. Items 1–3 gate the build order
(rollout note, §12); the rest can resolve during it.

1. Any per-invocation turn/step cap (`--max-turns` equivalent)? If none, confirm the
   watchdog knob (§2.1) suffices — noting K7 as-built runs uncapped too.
2. Exact `turn.completed` usage/cost schema; per-invocation or cumulative across `resume`;
   whether any usage appears mid-stream (gates the mid-invocation budget kill, §4.3).
3. `--ask-for-approval never` + `default_tools_approval_mode = "approve"` actually
   pre-approves shim tool calls (vs the
   [#24135](https://github.com/openai/codex/issues/24135) auto-cancel). Determines the
   `--yolo` fallback (§3.3) — confirm **before committing the rest of the build**.
4. Whether ChatGPT-subscription auth persists a token under `CODEX_HOME` (host-visible
   mount) — parallel to Claude Code's `.credentials.json` question (§4.1, §5.1).
5. `npm install -g @openai/codex@<ver>` still the recommended install path (§8.1).
6. Telemetry/autoupdate/phone-home disable mechanism (§7.2).
7. On-disk session/rollout layout under `CODEX_HOME` (§5.1 — needed for snapshot copy).
8. Can a session id be supplied up front (a `--session-id` analog), or is it only minted via
   `thread.started`? (§2.2)
9. `developer_instructions` semantics (§2.4): confirm it *appends* developer-level
   instructions (vs `model_instructions_file`, which replaces the built-ins, and
   `instructions`, reserved) — and confirm workspace `AGENTS.md` files are
   ignorable/overridable so an untrusted repo can't inject persona-level instructions.
10. The untrusted-project pin (§3.1): confirm `[projects."/workspace"] trust_level =
    "untrusted"` suppresses **every** project-scoped `.codex/` layer (config, MCP servers,
    hooks, rules) on the pinned CLI — pair with the planted-config live probe (§9).
11. Web search: server-side (rides the model call) or client-side fetch (§3.3)?
12. How a `required = true` MCP startup failure surfaces (§4.2): nonzero exit, `turn.failed`,
    or another shape — the runtime must map it to a failed turn; also confirm
    `startup_timeout_sec` is honored under `codex exec`.
13. Proxy config shape (`openai_base_url` vs `model_providers.<id>` + `wire_api`/`env_key`)
    — needed only when the locked-down proxy work is funded (§4.1).

---

## 11. Quick reference

**Invocation (per harness turn):**
```bash
codex exec --json \
  [resume <session-id>] "<prompt>" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --model gpt-5-codex \
  --cd /workspace
# fallback posture only (verify-on-pin #3): --dangerously-bypass-approvals-and-sandbox
```

**Container env (§4.1):** direct mode (bridge default) → `CODEX_API_KEY=<Marathon spend
key>`; subscription (dev-only) → ChatGPT auth + `MARATHON_CODEX_SUBSCRIPTION_DEV=1`
acknowledged; locked-down → fails closed until the OpenAI proxy lands. Plus
`CODEX_HOME=/workspace/.marathon-home/.codex` · `HOME=/workspace/.marathon-home` (image) ·
the phone-home disable (*verify-on-pin* #6).

**Config (atomically rewritten per turn — config only, never the session state beside it):**
`$CODEX_HOME/config.toml` → `[mcp_servers.marathon]` (shim command +
`--socket`/`--tcp`+`--token`, `default_tools_approval_mode = "approve"`, `required = true`,
`startup_timeout_sec`) · `developer_instructions = "<persona>"` (§2.4) ·
`[projects."/workspace"] trust_level = "untrusted"` (§3.1).

**Events:** `thread.started` (session id) → `item.*` (progress) → `turn.completed`
(text, usage, done) / `turn.failed` (not-done).

**Sessions:** under `$CODEX_HOME` (layout *verify-on-pin* #7); resume
`codex exec resume <id>`; snapshots → `sessionDir/<taskId>/turn-<N>`.

**Marathon seams:** `AgentRuntime` (`packages/agent/src/types.ts:109`) · factory
(`packages/agent/src/runtime-factory.ts:50`) · shim (`packages/mcp-shim/src/`) · broker
(`packages/tools/src/broker.ts:25`, `broker-transport.ts:29`) · gateway
(`packages/tools/src/gateway.ts:118`) · harness config + validation
(`packages/config/src/index.ts:152`, `:512`) · BUILD wiring
(`packages/github-app/src/build.ts:196`, `:204`) · K7 template
(`packages/agent/src/claude-code.ts`, `claude-stream.ts`).

**Design:** §7.5 (harness seam) · §12.6 Pattern 1 (isolation) · §11.2/§11.6 (checkpoints,
waits) · §13.1 (harness pins provider) · §29 (BUILD contract) · `codex-impl.md` Part A
(events/roles — orthogonal, already shipped) · §12 below (milestone).

---

## 12. Milestone definition (roadmap §2c shape — K8)

### K8 — Codex CLI harness (headless) behind `AgentRuntime`

**Goal:** Marathon runs with **any of three harnesses** — `harness: pi | claude-code |
codex`, selected per deployment with a per-agent override (design §7.5) — with identical
governance, durability, and delivery. Same gateway chokepoint, same snapshot-based
checkpoint, same between-turn resume. **Non-blocking:** like K7, this does not gate the §0.6
bar; sequence it alongside other work. Full integration reference: **this document**
(`codex-cli-impl.md`, superseding `codex-impl.md` Part B).

Human prerequisites:
- An **OpenAI API key dedicated to Codex** (billing + spend cap) in the secret store
  (`secret/openai-codex`) — a spend credential, separate from the Pi/model-gateway key.
- Approve adding the `codex` CLI — **exact-version-pinned, autoupdate disabled** — to the
  pinned sandbox toolchain image (bump `SANDBOX_VERSION` + the toolchain manifest). The shim
  and settings machinery are already in the image from K7.
- Egress: nothing new — the kernel default stays `sandbox.network: bridge`; the locked-down
  posture for Codex is explicitly deferred (fails closed) until the OpenAI key proxy is
  funded (§4.1).

Build (per this doc):
- **Pin-verification spike first** (§10 items 1–3): the approval-mode behavior decides the
  default-vs-`--yolo` posture and should be confirmed before the rest of the build.
- **`CodexAgentRuntime`** (`packages/agent/src/codex.ts`) + **`codex-stream.ts`** reducer:
  one harness turn = one `codex exec --json` invocation in the task's container;
  whole-invocation checkpoint granularity (K7 as-built parity) with the optional wall-clock
  watchdog knob; session-id capture from `thread.started`; snapshot/resume per §5.2.
- **Governed tools:** reuse `marathon-mcp-shim` + broker verbatim; atomic per-turn
  `CODEX_HOME/config.toml` writer (config only — never the session state beside it) with
  the pre-approved, **`required = true`** Marathon MCP server + startup timeout, the
  `developer_instructions` persona, and the `[projects."/workspace"]
  trust_level = "untrusted"` pin (§2.4, §3.1, §3.3).
- **Model access:** direct `CODEX_API_KEY` on bridge; subscription mode behind
  `MARATHON_CODEX_SUBSCRIPTION_DEV`; `codex`+`network: none` fails closed (§4.1).
- **Config:** `AgentHarness` third value; `validateHarnessConfig` `codex` branch
  (OpenAI-only models, fail closed); §13.1 table row; BUILD wiring via the existing
  `makeAgentRuntime` factory — worker step runners untouched.
- **Image:** pinned `@openai/codex` + manifest line (§8.1).

Depends on: K7 (the shim, broker transports, subprocess-harness template, and factory it
reuses), K1 (the code path it must reproduce). Can proceed in parallel with other
post-kernel work.

Exit criteria:
- *Unit tests:* per §9 (reducer, argv/config builders, model access fail-closed paths,
  snapshot/restore, config cross-validation).
- *Automated demo* (`make demo-k8`): a fake `codex` binary drives the task pipeline green
  through the real broker, gateway, and container — tool calls audited, cost captured,
  kill-and-resume mid-run.
- *Live smoke + the real bar:* **re-run the K1–K4 demos and `make demo-kernel` green with
  `harness=codex`** — the loop works identically on all three harnesses.
