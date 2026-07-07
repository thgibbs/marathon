# Claude Code Harness — Implementation Guide for Marathon (K7)

The integration reference for the **Claude Code (headless) harness** — the second
`AgentRuntime` behind the seam (design §7.5, roadmap **K7**), the way `pi-details.md` is the
reference for the Pi harness. It covers what the `claude` CLI gives us headless, how each
piece maps onto Marathon's existing seams (with file:line pointers into this repo), the
hardened security shape (design §12.6 Pattern 1), and the build plan.

> **Source & version.** CLI behavior verified against the official Claude Code docs
> (code.claude.com/docs, July 2026). Claude Code ships fast — **pin a CLI version in the
> sandbox toolchain image** (§8.1) and re-verify the items marked *verify-on-pin* (§10)
> against that version before relying on them.

---

## 1. What Claude Code headless is

- **Claude Code** is Anthropic's coding agent CLI. In **print mode** (`claude -p`) it runs
  one non-interactive agentic run — prompt in, agent loop (model calls + tool calls) until
  done, structured events out — and exits. No TUI, no human at the keyboard.
- Distribution: the `@anthropic-ai/claude-code` npm package (also a native installer).
  For the container, `npm install -g @anthropic-ai/claude-code@<pinned>` in the toolchain
  image; the autoupdater is disabled (§7.2) so the pin holds.
- Built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`,
  `Task` (sub-agents), `TodoWrite`, … — restrictable per run (§3.3).
- External tools attach over **MCP** (Model Context Protocol) — stdio, HTTP, or SSE servers
  (§3.1). This is how Marathon's governed tools arrive.
- Sessions are **durable JSONL transcripts** the CLI writes itself and can resume (§5).
- **Claude Code calls the model itself** and only speaks the Anthropic API — the harness
  choice pins the provider (design §13.1). The endpoint is redirectable via
  `ANTHROPIC_BASE_URL`, which is what makes the key-injecting proxy possible (§4).

**Marathon fit:** Claude Code is the textbook **Pattern 1** harness (design §12.6): the whole
agent loop runs *inside* the sandbox as a subprocess, its file/bash tools are contained by
construction (they see only `/workspace`), governed tools are brokered back to the host, and
the model call exits only through the host-side proxy. Where Pi is embedded in-process and
has its tool *execution* routed into the container (Pattern 2), Claude Code is the inverse:
the process lives in the container and only governed calls come out.

```text
        HOST (trusted)                          │   SANDBOX CONTAINER (untrusted)
                                                │
  ClaudeCodeAgentRuntime.nextTurn()             │
    └─ docker exec: claude -p --resume <sid>    │   claude CLI (pinned)
         --output-format stream-json …  ───────┼──►  agent loop
    ◄── stream-json events on stdout ───────────┼───  Bash/Read/Write/Edit → /workspace only
                                                │       │
  serveToolBroker on unix socket  ◄─────────────┼─── marathon-mcp-shim (stdio MCP server,
    └─ ToolGateway.run (validate → policy →     │        spawned by claude; forwards
       ledger → egress → creds → execute →      │        tools/call over the socket)
       redact → audit)                          │
                                                │
  model proxy (injects tenant key,  ◄───────────┼─── ANTHROPIC_BASE_URL=http://proxy:8080
    allowlists api.anthropic.com)  ──► Anthropic│      (bridge or internal-only — §7.1)
```

---

## 2. How Marathon runs it — the turn model

### 2.1 One harness turn = one `claude -p` invocation

The `AgentRuntime` seam is a single method — `nextTurn(ctx): Promise<AgentTurn>`
(`packages/agent/src/types.ts:106`). For Claude Code:

- **A harness turn is one print-mode invocation.** First turn:
  `claude -p <prompt> --session-id <uuid> …`; every later turn:
  `claude -p <prompt> --resume <session-id> …`. The CLI's *internal* turns (model→tool
  cycles, reported as `num_turns`) happen inside one invocation.
- **Checkpoint cadence is controlled with `--max-turns N`.** An unbounded BUILD invocation
  could run for an hour with no checkpoint — unacceptable for K4. Bound each invocation
  (e.g. `--max-turns 10`); when the run stops on the cap (`result.subtype ==
  "error_max_turns"`), the harness turn ends *not-done*, the runtime checkpoints (§5.2),
  and the next `nextTurn` resumes with a neutral continuation prompt ("continue with the
  task"). `subtype == "success"` means the run completed → evaluate done-ness (§2.2).
- The invocation runs **inside the task's `DockerContainer`** via
  `container.execStream(...)` (`packages/tools/src/sandbox.ts:184`) — same lifecycle the
  Pattern-2 tools use, owned by `nextTurn` exactly as `PiAgentRuntime` owns it
  (`packages/agent/src/pi.ts:244-250`).

### 2.2 Mapping onto `AgentTurn`

| `AgentTurn` field (`types.ts:64`) | Claude Code source |
| --- | --- |
| `text` | `result.result` (the final text) — `assistant` events for streaming progress |
| `modelInvocation` | `result.total_cost_usd` + `result.usage` (§4.3); omitted when the per-turn sink reports it, mirroring `pi.ts:396` |
| `done` | `result.subtype == "success"` **and** no pending `ask_user` (§2.3); `error_max_turns` ⇒ `done: false` |
| `waiting` | set when the run ended after an `ask_user` MCP call (§2.3) |
| `sessionRef` | the Claude session id + the turn-snapshot path (§5.2) |
| `turnIndex` | Marathon's own counter from `checkpoint` (Claude's `num_turns` is per-invocation, not global) |

### 2.3 Clarifying questions (`waiting`)

Pi exposes `ask_user` as a custom tool (`pi.ts:92`); Claude Code gets the same tool **over
MCP**. The shim forwards `ask_user` to the broker like any governed tool; the broker records
the question and returns "question recorded — end your response now and wait for the
answer." When the invocation completes, the runtime sees the recorded question and returns
`waiting: { question }` — the §11.6 async shape. The answer arrives as the next turn's
prompt over `--resume`. No mid-turn suspend, same as Pi.

---

## 3. Governed tools over MCP (the key integration)

### 3.1 The shape: stdio shim → broker socket → `ToolGateway`

Marathon's governed tools are served to Claude Code as **one MCP server backed by
`gateway.run`**. The broker already exists — `handleToolRequest`
(`packages/tools/src/broker.ts:25`) over line-delimited JSON on a duplex stream
(`packages/tools/src/broker-transport.ts:29`, `serveToolBroker`) — and was built for exactly
this consumer. What's new is the MCP face:

- **`marathon-mcp-shim`** — a small Node script baked into the toolchain image. Claude Code
  spawns it as a **stdio MCP server** (its stdio speaks MCP JSON-RPC to the CLI). It
  implements `initialize`, `tools/list`, and `tools/call`, and forwards every `tools/call`
  as a `ToolBrokerRequest` over **a per-task unix socket mounted into the container**
  (e.g. `/run/marathon/broker.sock`). The host side of that socket is `serveToolBroker`
  bound to the task's `ToolGateway` context.
- **`tools/list` comes from the broker too** — extend the broker protocol with a
  `list_tools` request returning the task's registered governed tools (name, description,
  JSON-schema parameters, from the `ToolRegistry`). The shim carries **zero configuration
  and zero secrets**; everything is resolved host-side per task.
- MCP config is passed explicitly and exclusively:

  ```json
  { "mcpServers": { "marathon": {
      "type": "stdio",
      "command": "marathon-mcp-shim",
      "args": ["--socket", "/run/marathon/broker.sock"]
  } } }
  ```

  via `--mcp-config <file> --strict-mcp-config` (ignore any user/project MCP servers — the
  workspace is untrusted and must not be able to add servers via a checked-in `.mcp.json`).

> **Why a shim and not MCP-over-HTTP:** the hardened network shape (§7.1) gives the
> container no route to host ports, and `claude` cannot dial a unix socket as an MCP URL.
> A stdio server that proxies to a mounted socket needs neither. *Caveat:* unix-socket
> bind-mounts must be verified on the deployment's Docker (Docker Desktop on macOS has
> historically been flaky here — a K7 spike item; the fallback is a second internal-network
> endpoint like the model proxy, §7.1).

### 3.2 What the gateway pipeline preserves

`ToolGateway.run` (`packages/tools/src/gateway.ts:118`) is unchanged: validate → policy
enforce → egress route vs the source ledger → ledger record → credential-injected execute →
redact → audit. The broker response is **redacted again before it crosses back**
(`broker.ts`), so tool results enter the container — and therefore the Claude session
JSONL — already clean. `requires_proposal` outcomes surface as typed refusals, same as Pi's
custom tools. Audit rows (`ToolInvocation`) are written by the gateway host-side — the
**gateway records are the source of truth**; the stream-json events only power progress and
the timeline (§4.2).

Tool naming: MCP tools surface to the model as `mcp__marathon__<tool>`. Marathon already
sanitizes `github.read_file` → `github_read_file` for Pi (`pi-details.md` §1); the same
sanitized names are what the shim lists, and the broker maps back.

### 3.3 Constraining the built-ins

The harness's own permission machinery is **defense-in-depth, never the security boundary**
— containment (the container) and the gateway (host-side) are the boundary (design §12).
Per run:

- `--permission-mode bypassPermissions` — headless runs can't answer prompts; a prompt would
  hang the invocation. Safe *because* the process is contained and credential-free.
- **The tool posture follows the sandbox egress posture** (`sandbox.network`, §7.1):
  - `Task` (sub-agents) is disallowed in either posture, initially — it multiplies sessions
    and would complicate the one-session-one-JSONL checkpoint story (revisit post-K7).
  - **`WebSearch` stays allowed in both postures.** It is a **server-side tool** — the
    search executes on Anthropic's side of the messages API — so it rides the model call
    through the proxy and works even with zero container egress (*verify-on-pin*, §10).
  - **`WebFetch` fetches client-side**, so it follows the network: allowed under
    `network: bridge` (the kernel default — doc lookups are normal work there), disallowed
    under the internal-only posture where it can only fail.
  - Package installs (`npm install` via `Bash`) likewise work under bridge and are simply
    unavailable locked-down — same trade the Pattern-2/Pi sandbox already makes.
- Keep `Bash/Read/Write/Edit/Glob/Grep` — they see only `/workspace`, exactly like the
  Pattern-2 sandboxed tools (`GUEST_WORKSPACE`, `packages/agent/src/sandbox-tools.ts:29`).
- A Marathon-managed `settings.json` (via `--settings`) pins the same denies declaratively.
  *Verify-on-pin:* whether `permissions.deny` rules hold under `bypassPermissions` is not
  documented — assert it in a K7 unit test, and rely on the flags + containment regardless.

### 3.4 System prompt and input

- `AgentRequest.instructions` (the agent persona from the YAML, `types.ts:16`) goes in via
  **`--append-system-prompt`** — appending to (not replacing) the CLI's own system prompt
  keeps its tool-use behavior intact.
- `AgentRequest.input` is the `-p` prompt. Untrusted surface content stays fenced inside it
  (`<<<UNTRUSTED>>>` markers, §7.18 context layering) — identical to the Pi path; the trust
  hierarchy is prompt-construction, not harness machinery.

---

## 4. Models, auth & cost

### 4.1 Model access — direct key by default, proxy for the locked-down posture

**Decision (2026-07-07): the model proxy is opt-in on `network: bridge`, required only under
locked-down egress (`network: none`); the default on bridge is direct key injection.** Two
postures, chosen by `resolveModelAccessEnv` (`packages/agent/src/claude-code.ts`):

- **Direct (the default on `network: bridge`).** A Marathon-dedicated Anthropic key from the
  secret store (`secret/anthropic`) is injected into the container at launch as
  `ANTHROPIC_API_KEY`; no `ANTHROPIC_BASE_URL`, no proxy. **Rationale:** on the kernel-default
  bridge posture the sandbox already has open outbound internet, so a proxy adds **no data
  boundary** — a malicious process (or an injected prompt that induces one) can already exfil
  workspace contents to any host. The proxy would only hide the key from a *non-code-exec*
  leak, and the threat model here is an agent that runs arbitrary code, so that marginal
  bar-raising is small. Treat the injected key as a **low-blast-radius spend credential**
  (dedicated to Marathon, provider-budget-capped, rotated) — never a business/data credential.
  The GitHub/Slack/document credentials stay brokered on the host in **both** postures
  (design §12.6, `12-security-design.md:284`), which is the boundary that actually matters.
- **Proxy (opt-in on bridge; REQUIRED under `network: none`).** When `MARATHON_MODEL_PROXY_URL`
  is set, the container gets `ANTHROPIC_BASE_URL=http://<proxy>/` and a **placeholder**
  `ANTHROPIC_API_KEY=marathon-proxy` (the CLI needs *a* key; the proxy discards it). The proxy
  injects the real key host-side, allowlists only Anthropic API paths, and is the **sole
  reachable endpoint** in the internal-only network of the locked-down posture (§7.1). This is
  where the proxy earns its keep: with outbound severed, it is the one carve-out for the model
  call and the allowlist actually bites.

**Why not proxy-by-default (the original design).** Of the three things the proxy bought,
two are ~zero on bridge and the third is minor: (a) the path allowlist only bites when the
proxy is the sole egress — moot on bridge's open outbound; (b) the **backstop metering** is
redundant and, for the streaming CLI, effectively dead — `parseUsageFromAnthropicResponse`
parses a non-streamed body, but Claude Code streams, and budget enforcement already reads
usage from the stream (§4.3), not the proxy; (c) key-out-of-container only matters against
key theft, and only strongly under no-egress. So the proxy is **optional hardening, not the
default architecture**. `AnthropicKeyProxy` (`packages/model-gateway/src/proxy.ts`) is kept
as the mechanism for the locked-down/compliance mode and the bridge opt-in.

**Fail-closed rules (`resolveModelAccessEnv`):** direct mode with no key → throw; locked-down
egress with no proxy → throw (the container has no other route to the model API). The
harness/model cross-validation (`validateHarnessConfig`) no longer requires a proxy — that is
now a posture-specific runtime check, not a config-load one.

> **Future work — scoped model credentials (the real missing primitive).** Direct mode is
> only as safe as the key is low-value. Marathon should be able to issue **per-tenant or
> per-deployment Anthropic credentials with provider-side spend caps + rotation** (Anthropic's
> Admin API supports workspace-scoped keys with limits) so that key theft from a sandbox has
> bounded blast radius. Until that lands, a deployment that injects one shared org key is
> **accepting spend-theft / rate-limit-DoS risk** — acceptable for dogfood/self-host, but it
> should be a stated acceptance. This primitive is what makes direct-by-default properly safe;
> the proxy is a workaround for not having it.

### 4.2 Event stream → Marathon records

`--output-format stream-json --verbose` (required together in print mode) emits one JSON
object per line:

| Event | Marathon mapping |
| --- | --- |
| `{"type":"system","subtype":"init",…}` | session id capture (first turn); log the reported tools + MCP server status (a failed `marathon` MCP mount **fails the turn fast** — never run BUILD without governed tools) |
| `{"type":"assistant","message":{…}}` | streamed text + `tool_use` blocks → `onEvent {type:"tool_start", toolName}` (`AgentProgressEvent`, `types.ts:57`); per-message `usage` accumulates for in-run budget checks (§4.3) |
| `{"type":"user",…}` (tool results) | `onEvent {type:"tool_end"}` summaries (size-capped) |
| `{"type":"result",…}` | turn end: `text`, cost/usage → `ModelInvocationData`, `num_turns`, `session_id`, `subtype` → done/continue (§2.1) |

`--include-partial-messages` (finer streaming deltas) is unnecessary — Marathon's progress
events are capped and coarse.

### 4.3 Cost capture and budget enforcement

- Per harness turn, build `ModelInvocationData` (`types.ts:4`) from the `result` event:
  `costUsd = total_cost_usd`, tokens from `usage` (input/output + cache read/write),
  `latencyMs = duration_api_ms`, status from `is_error`/`subtype`. Reported through
  `onTurnCheckpoint` exactly like Pi (`pi.ts:409`), feeding the existing
  `Database.recordStepResult` path (`packages/db/src/index.ts:332`).
  *Verify-on-pin:* whether `total_cost_usd` is per-invocation or cumulative across
  `--resume` — if cumulative, record the delta against the previous checkpoint.
- **Budgets are enforced at two grains.** Between harness turns, the existing
  `assertWithinBudget` check (`packages/worker/src/agent-step.ts:110-117`) works unchanged.
  *Within* an invocation — which `--max-turns` already bounds — the runtime accumulates
  streamed `assistant` usage and **kills the process on breach** (SIGTERM; the turn is
  discarded per the §11.2 mid-turn rule and the task fails with the budget error). The
  CLI's `--max-budget-usd` flag exists but its enforcement semantics are undocumented —
  pass it as belt-and-suspenders, never as the enforcement (*verify-on-pin*).
- **Model selection:** `modelRef` is `"provider:model"`; the runtime passes the model id via
  `--model`. **`provider` must be `anthropic`** — config wiring fails closed at load time
  when `harness: claude-code` is paired with a non-Anthropic model policy (design §13.1:
  harness choice constrains provider choice). `--fallback-model` may name a cheaper
  Anthropic model for overload fallback.

---

## 5. Sessions, durability & resume

### 5.1 Where the session lives — inside the workspace home

Claude Code writes its session JSONL under `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/
<session-id>.jsonl`. The toolchain image already sets `HOME=/workspace/.marathon-home`
(`docker/sandbox/Dockerfile:67`) — task-sized disk on the host-visible workspace mount,
**excluded from the repo's git view by the workspace manager**, so nothing under it enters
diffs, tree hashes, or the PR. Set `CLAUDE_CONFIG_DIR=/workspace/.marathon-home/.claude`
explicitly and the whole session/config story lands there by construction:

- **Host-visible** — the runtime persists/snapshots the JSONL without `docker cp`.
- **Diff-excluded** — the session (which contains the full trace) can never ride
  `git diff base_sha..worktree` into a PR (§29.4 reads only the repo view).
- **Ephemeral** — teardown destroys it with the workspace; the durable copies are
  Marathon's snapshots (§5.2). Tool results in it are pre-redacted by the broker (§3.2), and
  the CLI does not write its API key into the session — so the file is clean by construction
  (in proxy mode the key isn't in the container at all; in direct mode it lives only in the
  process env, not the JSONL).

### 5.2 Checkpoint/resume (K4 contract, design §11.2)

Mirror `resolvePiSession` + the per-turn snapshot (`pi.ts:107`, `pi.ts:316-322`):

- **After each completed invocation**, copy the live session JSONL to
  `sessionDir/<taskId>/turn-<N>.jsonl` (host-side) and emit `onTurnCheckpoint
  { turnIndex, sessionRef: { sessionId, snapshotPath }, modelInvocation }`.
- **Resume** (`checkpoint.sessionRef` present): re-provision a fresh container,
  re-materialize the workspace (clone at `base_sha` + replay the checkpointed workspace
  diff), **restore the snapshot JSONL to its expected path** under `CLAUDE_CONFIG_DIR`,
  then `claude -p --resume <sessionId>`. Restoring the snapshot *over* whatever a crashed
  invocation left behind is what "discard the incomplete turn and replay" means here — the
  partial JSONL is simply overwritten.
- **Containers are never recovered**; interrupted invocations rerun from the last snapshot;
  re-executed governed calls converge on idempotency keys (`§11.3`) and the handoff
  converges on `(task_id, tree_hash)` (§29.4). Unchanged from the generic contract.
- `--session-id <uuid>` pins the id on the first turn so `sessionRef` is known before the
  process ever runs; `--fork-session` exists if a branched replay is ever needed (not used
  in K7).

---

## 6. `ClaudeCodeAgentRuntime` — implementation sketch

New file `packages/agent/src/claude-code.ts`, sibling of `pi.ts`:

```ts
export interface ClaudeCodeAgentOptions {
  secrets: SecretStore;                    // resolved host-side; feeds the proxy, never the env
  sessionDir?: string;                     // per-task snapshots, as PiAgentOptions.sessionDir
  sandbox: {                               // REQUIRED — this harness has no host mode
    createContainer(req, workspace): DockerContainer;
  };
  governed?: GovernedToolsConfig;          // same spec list; served via broker+shim, not defineTool
  proxy: { baseUrl: string };              // the model proxy endpoint on the internal network
  maxTurnsPerInvocation?: number;          // checkpoint cadence, default ~10
  clarification?: boolean;                 // expose ask_user over MCP (§2.3)
  cli?: { bin?: string; settingsPath?: string };
}

export class ClaudeCodeAgentRuntime implements AgentRuntime {
  async nextTurn(ctx: AgentTurnContext): Promise<AgentTurn> {
    // 1. container + workspace up (as pi.ts:244); bind the broker unix socket into it
    // 2. serveToolBroker(socket, gateway, { taskId, tenantId, agentId })  — host side
    // 3. restore session snapshot if ctx.checkpoint.sessionRef (§5.2)
    // 4. argv: claude -p <prompt> [--resume <sid> | --session-id <uuid>]
    //      --output-format stream-json --verbose
    //      --max-turns N --model <id> --append-system-prompt <instructions>
    //      --mcp-config <shim config> --strict-mcp-config
    //      --permission-mode bypassPermissions --disallowedTools "WebFetch,WebSearch,Task"
    //      --settings /etc/marathon/claude-settings.json
    //    env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY=placeholder,
    //         CLAUDE_CONFIG_DIR=/workspace/.marathon-home/.claude,
    //         CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    // 5. parse stream-json lines → onEvent progress + usage accumulation (budget kill)
    // 6. on result: snapshot session → onTurnCheckpoint → return AgentTurn (§2.2)
    // 7. finally: container.stop(); teardown never persists anything locally
  }
}
```

Unit-testable seams, mirroring how `pi.ts` and `sandbox.ts` are tested: pure
`claudeArgv(opts, checkpoint)` builder; pure stream-json line reducer
(`events → {progress, usage, result}`); the shim's MCP↔broker mapping against a fake
duplex; snapshot/restore path logic.

**Wiring** — branch on `spec.harness` (already parsed and validated,
`packages/config/src/index.ts`) via a shared `makeAgentRuntime(spec, deps)` factory. In the
K7 slice this is wired at the **BUILD** site only (`packages/github-app/src/build.ts`):
Claude Code runs its whole loop *inside a per-task code container*, so it needs the
workspace binding, the container factory, and the model proxy — all of which the BUILD
stage provides. The **chat/general-agent surface** (`packages/slack-app/src/app.ts`) has no
code workspace, so it stays on Pi and rejects `claude-code` (`assertSupportedHarness`);
general-chat container binding is a follow-on. The worker step runners
(`packages/worker/src/agent-step.ts`) need **no changes** — the seam holds. BUILD wiring
**fails closed** when a `claude-code` agent's model policy is non-Anthropic (§4.3), when
direct mode has no Anthropic key configured, or under the locked-down `network: none` posture
whose internal-network proxy wiring is a pending spike (§7.1). The model proxy is **optional**
on the bridge default (direct key injection, §4.1) — not a wiring requirement.

---

## 7. Security lockdown (design §12.6 Pattern 1, hardened)

### 7.1 Network: two postures, one invariant

The egress posture is **per-agent configuration** (`sandbox.network: bridge | none`,
`packages/config/src/index.ts:65`; "none from any source wins",
`packages/agent/src/sandbox-factory.ts:70`), and the invariant that holds in **both** is
**business-credential-freedom**: no GitHub/Slack/document token, and no other data credential,
ever enters the container — those stay brokered on the host (§3.1). The *model* credential is
the one exception, and how it's handled is the posture difference (§4.1): a low-value Anthropic
**spend** key is injected directly on bridge, or kept out entirely behind the proxy under
lockdown.

- **`bridge` — the kernel/dogfood default** (`agents/forge.yaml`; Dockerfile Track 8):
  outbound internet for package installs, doc lookups, and `WebFetch`. The model call goes
  **direct** with the injected Marathon spend key (§4.1) — a proxy here would add no data
  boundary, since outbound is already open. Accepted for the kernel because the container
  carries no business credentials and the workspace is a company-viewable repo — the
  exfiltration surface is bounded by what's already in the tree (OQ-4 calibration). Direct
  egress here bypasses the gateway's source-ledger routing, which is exactly why
  restricted-source tenants need the locked-down posture instead.
- **Internal-only — the locked-down posture.** `--network none` would sever the model call
  too, so "locked down" is not literally `none` for this harness: a per-deployment
  **internal Docker network** (`docker network create --internal marathon-egress`, no
  outbound route, no host ports) whose only members are the sandbox and the **model proxy**
  (§4.1) — the proxy is the sole reachable endpoint and the only component with an outbound
  route, so here the proxy is **required** and the model key stays host-side. `WebSearch`
  still works (server-side, rides the proxy — §3.3); `WebFetch` and installs don't.
- **In both postures:** the **broker** stays a unix-socket mount (§3.1, not a network
  endpoint), and everything else from `hardeningFlags` (`packages/tools/src/sandbox.ts:69`)
  is unchanged: read-only root, tmpfs scratch, cap-drop ALL, no-new-privileges, non-root uid,
  cpu/mem/pids limits, and **no business secrets forwarded** (the bridge posture's direct
  model key is the sole, deliberate exception, §4.1).

### 7.2 Phone-home lockdown

Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (disables telemetry, error reporting,
update checks, and the autoupdater in one). Result: the CLI's only network dependency is
`ANTHROPIC_BASE_URL` — which is the proxy. The internal network makes this *enforced*, the
env var makes it *quiet* (no hanging retries against unreachable telemetry hosts).

### 7.3 What is and isn't the boundary

- **Boundary:** the container (code/FS containment), the broker + gateway (governed
  effects, credentials, audit, redaction), the proxy (model access + key custody), branch
  protection (nothing lands without a human merge).
- **Not the boundary:** Claude Code's permission modes, allow/deny lists, and settings —
  defense-in-depth only (§3.3). An injected agent that talks the model into ignoring them
  still can't reach credentials, the host, or unaudited egress.
- **Injection posture is unchanged from Pi:** untrusted content enters fenced in the prompt
  (§7.18); the session JSONL only ever contains broker-redacted tool results; the plan doc
  arrives as workspace *files*, not side-channel instructions (§29.2).

---

## 8. Toolchain image & config

### 8.1 Image additions (`docker/sandbox/Dockerfile`)

- `npm install -g @anthropic-ai/claude-code@<pinned>` — exact-version pin; bump
  `SANDBOX_VERSION` and the toolchain manifest (`claude: $(claude --version)`) so drift is
  observable, per Track 11.
- The `marathon-mcp-shim` script (from `packages/`, copied in at build).
- The Marathon-managed `claude-settings.json` at a fixed path (deny rules, no hooks).

### 8.2 Agent YAML (`§6.2`)

Already reserved: `harness: pi | claude-code` (`packages/config/src/index.ts:52`;
`agents/forge.yaml:14`). K7 adds load-time cross-validation: `harness: claude-code`
requires an Anthropic model policy (§4.3) and a configured proxy endpoint; violations fail
closed at wiring, like the repo-allowlist check does today.

---

## 9. Tests & demos (K7 exit criteria, roadmap §2c)

- **Unit:** stream-json reducer → `AgentTurn`/progress/usage mapping (incl. `error_max_turns`
  → not-done, malformed lines, `is_error` results); `claudeArgv` builder (resume vs first
  turn, flags, no secrets in argv); shim MCP↔broker bridging (list/call/typed errors/
  `requires_proposal`) against a fake stream; snapshot/restore including
  restore-over-partial; **model access** (`resolveModelAccessEnv`, §4.1) — proxy mode injects
  the placeholder (**assert no real key in the container env**), direct mode injects the
  Marathon spend key with no `ANTHROPIC_BASE_URL`, locked-down-without-proxy and
  direct-without-key both fail closed; proxy path allowlist; settings-deny-under-bypass probe
  (§3.3); config cross-validation (§8.2).
- **`make demo-k7`:** a **recorded/fake CLI** (a stub binary emitting a canned stream-json
  script, injected via `cli.bin`) drives the full pipeline with the real broker, gateway,
  and container: threaded reply, governed calls audited, cost captured, kill-and-resume
  mid-run. Deterministic, no network, no key — the same philosophy as `FakeAgentRuntime`
  demos, but exercising the real parsing/broker/snapshot machinery.
- **Live smoke + the real bar:** re-run the K1–K4 demos and `make demo-kernel` green with
  `harness=claude-code` — identical loop behavior on either harness is what "harnesses are
  replaceable" (§28 organ #1) means in practice.

---

## 10. Verify-on-pin checklist

Re-check against the pinned CLI version before K7 closes (docs were inconsistent or silent
in July 2026):

1. `permissions.deny` in settings enforced under `--permission-mode bypassPermissions`
   (undocumented — unit-test it; §3.3).
2. `total_cost_usd` semantics across `--resume` — per-invocation or cumulative (§4.3).
3. `--max-budget-usd` enforcement behavior (pass-through only until proven; §4.3).
4. `system:init` event field set (docs guarantee little beyond `session_id`; treat the rest
   as informational; §4.2).
5. Unix-socket bind-mount behavior on the deployment's Docker (macOS Docker Desktop; §3.1).
6. Exact `--allowedTools`/`--disallowedTools`/`--tools` flag spellings (the CLI reference
   and headless docs disagree; §3.3).
7. npm remains the supported container install path for the pinned version (§8.1).
8. `WebSearch` executes server-side (through the messages API, i.e. through the proxy) with
   no client-side fetch — confirm it works from the internal-only network (§3.3, §7.1).

---

## 11. Quick reference

**Invocation (per harness turn):**
```bash
claude -p "<prompt>" \
  --resume "<session-id>"            # or --session-id <uuid> on turn 1
  --output-format stream-json --verbose \
  --max-turns 10 --model claude-sonnet-4-6 \
  --append-system-prompt "<agent instructions>" \
  --mcp-config /etc/marathon/mcp.json --strict-mcp-config \
  --permission-mode bypassPermissions \
  --disallowedTools "Task"               # + "WebFetch" under the locked-down posture (§3.3)
  --settings /etc/marathon/claude-settings.json
```

**Container env:** `ANTHROPIC_BASE_URL=<proxy>` · `ANTHROPIC_API_KEY=<placeholder>` ·
`CLAUDE_CONFIG_DIR=/workspace/.marathon-home/.claude` ·
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` · `HOME=/workspace/.marathon-home` (image).

**Events:** `system:init` (session id, MCP status) → `assistant`/`user` (progress, usage) →
`result` (`subtype`, `total_cost_usd`, `usage`, `num_turns`, `session_id`).

**Sessions:** `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`; resume
`--resume <id>`; pin `--session-id <uuid>`; snapshots → `sessionDir/<taskId>/turn-<N>.jsonl`.

**Marathon seams:** `AgentRuntime` (`packages/agent/src/types.ts:106`) · broker
(`packages/tools/src/broker.ts:25`, `broker-transport.ts:29`) · gateway
(`packages/tools/src/gateway.ts:118`) · container (`packages/tools/src/sandbox.ts:153`) ·
harness config (`packages/config/src/index.ts:52`) · wiring sites
(`packages/github-app/src/build.ts:158`, `packages/slack-app/src/app.ts:104`).

**Design:** §7.5 (harness seam) · §12.6 Pattern 1 (isolation) · §11.2/§11.6 (checkpoints,
waits) · §13.1 (cost/provider coupling) · §29 (the BUILD contract — harness-agnostic by
construction) · roadmap K7 (milestone).
