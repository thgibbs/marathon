# Pi Harness — Notes for Marathon

Reference notes on the **Pi harness** (the agent runtime Marathon builds on), distilled
from <https://pi.dev/docs/latest> for the things Marathon needs: embedding, tool use +
permissioning, models/auth, logging, sessions/durability, and security.

> **Source & version.** Captured from the `/docs/latest` docs (June 2026). Pi ships fast
> and the model/provider lists change per release — **pin a Pi version** and re-verify
> these specifics against that version. Pages cited inline as `[providers]`, `[sdk]`, etc.

---

## 1. What Pi is

- Pi is a **minimal terminal coding harness**, extensible via TypeScript modules. It owns
  the in-task agent loop: prompting, tool calling, streaming, retries, compaction, and a
  durable session log.
- Maintained by **earendil-works**. Packages:
  - **`@earendil-works/pi-coding-agent`** — the harness + SDK (`createAgentSession`,
    `defineTool`, `SessionManager`, `AuthStorage`, `ModelRegistry`, `SettingsManager`,
    `DefaultResourceLoader`, run modes).
  - **`@earendil-works/pi-ai`** — model layer (`getModel`, `StringEnum`).
- Install: `npm install @earendil-works/pi-coding-agent` (or curl installer). Gondolin
  sandbox needs Node ≥ 23.6 + QEMU.
- CLI run modes: interactive TUI (default), **`pi --mode rpc`** (JSONL over stdio),
  **`pi --mode json "prompt"`** (read-only event stream), `runPrintMode`.

**Marathon fit:** Pi maps almost 1:1 onto the "Agent Worker runs the Pi harness" box in
`diagram.md`. The Agent Worker wraps Pi; Marathon owns durability, policy, credentials,
approval, audit *around* it.

---

## 2. How Marathon embeds Pi — three options

| Mode | Transport | Tool interception? | Best for |
| --- | --- | --- | --- |
| **SDK (in-process)** | TS function calls | **Yes** — `tool_call`/`tool_result` hooks + custom tools | **Recommended** for the worker (TS) |
| **RPC mode** | JSONL over stdin/stdout (`pi --mode rpc`) | Indirect — via `extension_ui_request`/approval dialogs + custom tools defined in the spawned Pi | Process isolation between worker and Pi |
| **JSON event stream** | stdout only (`pi --mode json`) | **No** (read-only observation) | Not usable for permissioning |

**Recommendation:** the TypeScript worker uses the **in-process SDK** — it gives direct
`tool_call` permission hooks, custom-tool registration, the event stream, and
`SessionManager` control in one process. Keep an **RPC-mode adapter** as a fallback if we
later want Pi in a separate process/sandbox (see §7). **Do not** use JSON mode for
anything but passive observation — it can't gate tools.

Minimal SDK bootstrap `[sdk]`:
```ts
import {
  createAgentSession, AuthStorage, ModelRegistry,
  SessionManager, SettingsManager, DefaultResourceLoader, defineTool,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

const authStorage = AuthStorage.create();                 // ~/.pi/agent/auth.json + env
authStorage.setRuntimeApiKey("anthropic", tenantKey);     // inject per-tenant key, not persisted
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  model: getModel("anthropic", "claude-opus-4-5"),
  authStorage, modelRegistry,
  tools: ["read", "grep", "find", "ls", /* + our custom tool names */],
  customTools: [/* defineTool(...) */],
  resourceLoader: loaderWithOurHooks,                      // registers tool_call/tool_result hooks
  sessionManager: SessionManager.create(perTaskDir),       // durable JSONL (see §6)
  settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
});
session.subscribe(ev => mapPiEventToMarathon(ev));         // logging/progress (see §5)
await session.prompt(userText);
```

---

## 3. Tool use & **embedded permissioning** (the key integration)

This is how Marathon puts permissioning *inside* Pi (per the design decision).

### 3.1 Defining tools
`[sdk]` `[extensions]` — tools use Typebox parameter schemas:
```ts
const ghReadPr = defineTool({
  name: "github_read_pr",
  label: "Read PR",
  description: "Read a pull request (shown to the model)",
  parameters: Type.Object({ repo: Type.String(), number: Type.Number() }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: await readPr(params) }], details: {} };
  },
});
```
- Built-in tools: `read, bash, edit, write, grep, find, ls` (default on: read/bash/edit/write).
  **`bash` is Pi's built-in command-line tool** — it directly satisfies our "CLI tools as a
  primary tool source." Extensions can **override a built-in** by registering the same name.
- Restrict the toolset: `tools: [...]` allowlist, `excludeTools: [...]`, `noTools:"builtin"`,
  or at runtime `pi.setActiveTools([...])` / `pi.getActiveTools()`.
- Tools signal failure by **throwing**; a returned object is never an error. Tools **must
  truncate** output (`truncateHead/Tail`, `DEFAULT_MAX_BYTES`=50KB, `DEFAULT_MAX_LINES`=2000).

### 3.2 The permission hook — `tool_call` (block + mutate)
`[extensions]` — registered via an extension (in-process through `DefaultResourceLoader`'s
`extensionFactories`):
```ts
const loader = new DefaultResourceLoader({
  cwd, agentDir,
  extensionFactories: [(pi) => {
    pi.on("tool_call", async (event, ctx) => {
      // event.toolName, event.toolCallId, event.input (MUTABLE)
      const decision = MarathonPolicy.check(event.toolName, event.input, agentCtx);
      if (decision.deny)      return { block: true, reason: decision.reason };
      if (decision.destructive && !decision.approved)
                              return { block: true, reason: "needs approval" }; // → §6.3 flow
      event.input = injectCredentials(event.toolName, event.input); // creds NOT from the model
      return { block: false };
    });

    pi.on("tool_result", async (event, ctx) => {
      auditToolInvocation(event);                 // write ToolInvocation + audit row
      return { content: redact(event.content) };  // redact before the model sees it
    });
  }],
});
```
**Marathon mapping:**
- `tool_call` hook = the **embedded permissioning chokepoint**. It evaluates Marathon's
  `ToolPolicy`, blocks denied/destructive-unapproved calls, and **injects credentials** by
  mutating `event.input` (so secrets never originate from the model).
- `tool_result` hook = **redaction + audit/logging** of tool output before it re-enters the
  model context.
- This directly resolves plan **risk #2** (confirming Pi exposes a per-call authorize hook).

### 3.3 Approval over RPC (if we ever run Pi out-of-process)
RPC mode emits `extension_ui_request` (methods: `select`, `confirm`, `input`, `editor`) and
takes `extension_ui_response` on stdin — usable to surface an approval prompt. In-process,
we don't need this; we drive approval through Marathon's orchestrator (§6.3).

---

## 4. Models, providers, auth & cost

### 4.1 Providers (covers our Claude / ChatGPT / OpenRouter choice) `[providers]`
- API-key providers include **Anthropic, OpenAI, OpenRouter**, Google Gemini, DeepSeek,
  Mistral, Groq, xAI, Bedrock/Vertex/Azure, and many more.
- Subscription OAuth via `/login`: ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot —
  **note:** Claude Pro/Max via a third-party harness "draws from extra usage and is billed
  per token." For Marathon we use **API keys / OpenRouter**, not subscription login.
- Select a model: `getModel(provider, modelId)` (SDK) or `--provider/--model` (CLI) or RPC
  `set_model`. `setModel`, `scopedModels` + `cycleModel`, `setThinkingLevel`
  (`off|minimal|low|medium|high|xhigh`; `xhigh` is OpenAI-only).

### 4.2 Auth — per-tenant keys without persistence `[providers]` `[sdk]`
- `AuthStorage` resolves keys: **runtime override → `~/.pi/agent/auth.json` (0600) → env
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) → custom-provider keys**.
- **`authStorage.setRuntimeApiKey(provider, key)`** sets a key for the process **without
  persisting** — this is how Marathon injects a tenant's key per task. Key fields also
  support `"$ENV"` interpolation and `"!command"` shell resolution.
- **Marathon note:** don't rely on `auth.json`/env for multi-tenant; provide keys at runtime
  from Marathon's secret store, scoped per task/tenant.

### 4.3 OpenRouter / custom providers `[custom-provider]`
```ts
pi.registerProvider("openrouter", {
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "$OPENROUTER_API_KEY",
  api: "openai-completions",                 // OpenAI-compatible
  models: [{
    id: "…", name: "…", reasoning: true, input: ["text","image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // $ / 1M tokens
    contextWindow: 200000, maxTokens: 8192,
    // thinkingLevelMap: {...}  // map pi thinking levels → provider values
  }],
});
```

### 4.4 Cost tracking (feeds Marathon's minimal model gateway) `[rpc]` `[custom-provider]`
- Each model carries **`cost` metadata** (input/output/cacheRead/cacheWrite per 1M tokens).
- Pi tracks usage per session; RPC `get_session_stats` returns
  `{ tokens:{input,output,total}, cost, contextUsage }`. The SDK exposes the same via session
  state/stats.
- **Marathon mapping:** our "minimal Model Gateway" can largely **read cost/tokens from Pi**
  (session stats + model cost metadata) rather than reimplementing metering — write a
  `ModelInvocation` row from the per-turn/`agent_end` events. Budgets are enforced from these
  actuals.

---

## 5. Logging, events & tracing

### 5.1 Event stream `[sdk]` `[rpc]` `[json]`
`session.subscribe(fn)` (SDK) / stdout lines (RPC, JSON). Event types:
- `agent_start` / `agent_end` (`messages`), `turn_start` / `turn_end` (`message`, `toolResults`)
- `message_start` / `message_update` (`text_delta`, `thinking_delta`, tool-call deltas) / `message_end`
- `tool_execution_start` (`toolName`, `args`) / `tool_execution_update` / `tool_execution_end`
  (`result`, `isError`)
- `queue_update`, `compaction_start/end`, `auto_retry_start/end`

**Marathon mapping:** map these to Marathon's records/UX —
- `tool_execution_*` → `ToolInvocation` rows + Slack/PR progress;
- `turn_end` / `agent_end` → `ModelInvocation` + cost; `TaskStep` boundaries;
- `auto_retry_*` → retry telemetry; `message_update` → streamed progress (rate-limited).

### 5.2 Full trace = the session JSONL (see §6)
The session file *is* a complete, replayable trace (messages, tool calls, tool results,
model changes, compactions). This backs Marathon's "**full trace logging on by default**,"
the inspectability dashboard, and the replay harness — we persist/own the session file per
task. Redaction happens in the `tool_result` hook (§3.2); also ensure prompts never contain
secrets (creds injected at `execute`, not into args).

---

## 6. Sessions, durability & the **approval-wait** pattern

### 6.1 Session model `[sessions]` `[session-format]`
- Sessions are **JSONL trees** at `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`. Entries
  carry `id` + `parentId` (branching without new files). Header: `{"type":"session","version":3,…}`.
- Entry types: `message` (roles: user, assistant, toolResult, bashExecution, custom,
  branchSummary, compactionSummary), `model_change`, `thinking_level_change`, `compaction`,
  `branch_summary`, `label`, `session_info`, `custom` (extension state, **not** in LLM
  context), `custom_message` (extension msg, **in** context).
- `SessionManager`: `inMemory()`, `create(cwd)`, `continueRecent(cwd)`, `open(path)`,
  `forkFrom(src, cwd)`. Append: `appendMessage`, `appendModelChange`, `appendCompaction`,
  `appendCustomEntry`, `appendLabelChange`, … Navigate: `getLeafId`, `getEntry`, `getBranch`,
  `branch(entryId)`, `branchWithSummary`, `buildSessionContext()` (leaf→root → LLM context).

**Marathon mapping:** give each task its own session dir/file; persist the **session file
path** (or contents) on the `Task` as the durable agent checkpoint. `custom`/`custom_message`
entries are a clean place to stash Marathon state (e.g., approval markers) in-band.

### 6.2 What Pi gives us for free
- Durable, resumable agent state on disk; crash-resume by `open(path)` + rebuild context.
- `abort()` (SDK) / `{"type":"abort"}` (RPC) to stop the current op.
- Auto-retry on transient errors (overloaded / rate-limit / 5xx) — matches our
  "automatic retry for transient failures."

### 6.3 The durable approval wait (plan risk #1) — **strategy, needs a spike**
Pi has **no native "suspend an in-flight turn for days."** But sessions are resumable, so the
intended Marathon pattern is **block-persist-resume**, not hold-open:

1. The `tool_call` hook detects a **destructive** call and returns `{ block: true }` (no
   execution, no process held).
2. Marathon records the pending action, persists the Pi **session file**, sets the task
   `waiting_for_approval`, posts the in-place prompt, and **tears down the worker/Pi**.
3. On approval (possibly days later), a worker re-opens the session
   (`SessionManager.open(path)`) and **re-enters** so the now-approved action runs.

The open question for the **§11 spike**: the cleanest re-entry mechanism. Options to validate:
- **(a) Re-prompt to continue** — resume with a steering/user message like "approved: proceed"
  and let the model re-issue the tool call (now allowed by policy). Simple; relies on the model
  redoing the call.
- **(b) Fork before the blocked call** — `branch`/`fork` to the entry just before the blocked
  `tool_call`, flip the policy to allowed, and re-run that node deterministically. More precise;
  avoids depending on the model.
- Record the approval as a `custom` entry so the trace shows the decision.

This confirms the plan's fallback ("orchestrator-scheduled steps; don't schedule the next step
until approved") is achievable on Pi, while honoring "**hold no process open for the wait**."
**Build a spike in M0/M1 to pick (a) vs (b) and confirm tool-result/My-policy semantics on
resume.**

### 6.4 Compaction
`/compact` (or auto) summarizes old context (`compaction` entries; RPC returns
`tokensBefore/After`). Long Marathon tasks benefit; can be disabled via settings. Be aware
compaction rewrites context — keep Marathon's authoritative records in our own DB, not only
in the Pi summary.

---

## 7. Security & sandboxing — **Pi provides none; Marathon must add it** `[security]` `[containerization]`

- Pi runs with the **full permissions of its OS user**; **no built-in sandbox**. Built-in
  tools (`bash`, file ops) and extensions run with that access. "Project trust" only guards
  *loading project config* before start — it does **not** restrict runtime or stop prompt
  injection.
- **Implication for Marathon:** never rely on Pi for isolation. Our defenses are (1) the
  `tool_call` policy hook, (2) treating all surface/tool/model content as untrusted (the agent
  trust hierarchy), and (3) **OS-level isolation** around Pi/tools.
- Isolation options Pi documents:
  - **Gondolin** (earendil-works) — local Linux **micro-VM**; an extension routes
    `read/write/edit/bash/grep/find/ls` into the VM, mounts cwd at `/workspace`, **keeps auth
    on the host**. Needs QEMU + Node ≥ 23.6.
  - **Plain Docker** — run the whole Pi process in a container (keys must enter the container;
    mount a named volume for `/root/.pi/agent`, not host creds).
  - **OpenShell** (NVIDIA) — policy sandboxes with **upstream credential injection** (sandbox
    code calls `https://inference.local`; gateway injects provider creds) — mirrors our
    "secrets never reach the model/agent" goal.

**Marathon mapping:** run the worker+Pi containerized per deployment; route tool execution
(especially `bash`/CLI and any write tools) through **Gondolin or an OpenShell-style sandbox**;
inject credentials at execution via the hook, never mount them where the agent can read them.
This is a **new requirement to add to the plan's M3/M9 security work** (the design assumed an
abstract isolation; Pi makes it our responsibility).

---

## 8. Settings & retries `[sdk]`

- `SettingsManager` (`create()`, `inMemory(overrides)`, `applyOverrides`): notably
  `retry: { enabled, maxRetries }` and `compaction: { enabled }`.
- Auto-retry covers transient provider errors; surfaced via `auto_retry_*` events and RPC
  `set_auto_retry` / `abort_retry`.
- Thinking levels per call/model (`setThinkingLevel`), steering/follow-up queues
  (`steer`/`followUp`, `streamingBehavior`).

---

## 9. Net effect on the Marathon plan

| Plan item | Pi reality | Action |
| --- | --- | --- |
| Embedded tool permissioning (risk #2) | **Confirmed** via `tool_call` block/mutate hook | Build policy + cred-injection in the hook (M3) |
| Durable approval wait (risk #1) | No native suspend, but resumable sessions | **Block-persist-resume**; spike re-entry (a vs b) in M0/M1 |
| Minimal model gateway + cost | Pi exposes per-model `cost` + session stats | Read cost from Pi; just route + record (M2) |
| Per-tenant model keys | `setRuntimeApiKey` (non-persistent) | Inject from secret store per task (M2) |
| CLI tools as primary | Built-in `bash` tool already does this | Wrap `bash` under policy (M3) |
| Logging/retries/redaction by Pi | Events + auto-retry + `tool_result` hook | Map events → records; redact in hook (M2/M3) |
| Full trace logging | Session JSONL is the trace | Persist session per task; power inspectability/replay (M2/M8) |
| Sandbox/isolation | **Pi has none** | Add containerization + Gondolin/OpenShell tool routing (M3/M9) |
| Document/GitHub tools | Custom tools via `defineTool` | Implement `github_*` / `document.*` tools (M3/M6) |

---

## 10. Quick reference

**Packages:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`
**Key SDK symbols:** `createAgentSession`, `defineTool`, `AuthStorage` (`setRuntimeApiKey`),
`ModelRegistry`, `SessionManager` (`create`/`open`/`continueRecent`/`branch`/`fork`),
`SettingsManager`, `DefaultResourceLoader` (`extensionFactories` → `pi.on("tool_call"|"tool_result")`),
`getModel`.
**Hooks:** `tool_call` → `{ block, reason }` (+ mutate `event.input`); `tool_result` → patch content.
**RPC:** `pi --mode rpc`; JSONL stdio; `prompt/steer/follow_up/abort`, `set_model`,
`get_session_stats`, `extension_ui_request/response`, session ops.
**Auth files:** `~/.pi/agent/auth.json` (0600); env `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / …
**Sessions:** `~/.pi/agent/sessions/…/<ts>_<uuid>.jsonl` (tree via `id`/`parentId`).

**Docs:** overview `/docs/latest` · sdk `/docs/latest/sdk` · extensions `/docs/latest/extensions`
· providers `/docs/latest/providers` · custom provider `/docs/latest/custom-provider`
· security `/docs/latest/security` · containerization `/docs/latest/containerization`
· sessions `/docs/latest/sessions` · session format `/docs/latest/session-format`
· rpc `/docs/latest/rpc` · json stream `/docs/latest/json`
