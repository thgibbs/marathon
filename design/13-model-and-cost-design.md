# 13. Model and cost design

## 13.1 Model abstraction

Model providers should implement a common interface:

```text
complete()
stream()
embed()
classify()
count_tokens()
estimate_cost()
```

Initial providers are **Anthropic (Claude), OpenAI (ChatGPT), and OpenRouter**. Local/self-hosted models are not supported initially.

Provider config:

```yaml
providers:
  anthropic:
    api_key_ref: secret/anthropic
    enabled: true

  openai:
    api_key_ref: secret/openai
    enabled: true

  openrouter:
    api_key_ref: secret/openrouter
    enabled: true
```

The **current default model is `openai:gpt-4o-mini`** (`DEFAULT_MODEL_POLICY`); Claude/OpenRouter are configurable per tenant/agent.

Much of this interface is provided by the harness and the provider SDKs; Marathon's own model layer stays minimal (see §9.2). Pi exposes per-model **cost metadata** (price per 1M tokens) and session cost/token stats that Marathon reads for budgets; per-tenant keys are injected at runtime (`setRuntimeApiKey`), and OpenRouter is registered as an OpenAI-compatible provider (see `pi-details.md` §4). Under the **Claude Code harness**, per-tenant keys are injected by the **host-side model proxy** (`ANTHROPIC_BASE_URL`) instead — the key never enters the sandbox (§12.6) — and cost/usage is read from the run's `stream-json` result event into the same `ModelInvocation` records, with the proxy metering request/response tokens as a **backstop** independent of what the agent-side CLI reports. Note the coupling: **harness choice constrains provider choice** — Claude Code runs Anthropic models, while Pi is provider-agnostic (Claude, ChatGPT, OpenRouter). This is enforced **fail-closed at config load**: `harness: claude-code` paired with a non-Anthropic model policy refuses to wire, rather than failing at run time (`claude-code-impl.md` §4.3, §8.2).

---

## 13.2 Routing strategies

Routing strategies:

### Static routing

Agent declares exact model per step.

Simple and predictable.

### Cost-aware routing

Platform chooses cheapest model that satisfies task constraints.

More complex, but valuable.

### Quality-aware routing

Platform uses eval history to choose models.

Advanced.

### Fallback routing

If one provider fails, use another.

Important for reliability.

MVP recommendation:

> Start with static routing plus fallback. Add cost-aware routing once usage data exists.

---

## 13.3 Cost controls

Required:

* Cost accumulation during task
* Hard budget stop
* Soft budget warning
* Admin cost dashboard
* Per-agent cost view
* Per-task cost view

**Cost is silent by default.** Accurate pre-task estimation is hard, so Marathon does not show inline estimates. Instead:

* Track cost as the task runs and enforce budgets (hard stop, soft warning).
* Report the **total cost on task completion** (e.g. a small footer on the final result, or in the admin/task view).
* Surface cost mid-task only on threshold breach or when the user/admin explicitly asks.

Budgets are enforced from the accumulating actual cost, not from an upfront estimate.

**Enforcement granularity per harness.** The step runner's budget check runs **between
harness turns** from recorded actuals. Under Pi a turn is one model call, so that check is
tight. Under Claude Code one harness turn is a whole `claude -p` invocation (many internal
model turns), so between-turn checks alone would let a runaway invocation blow through the
cap: the runtime therefore (a) bounds every invocation with `--max-turns`, and (b)
accumulates the streamed per-message usage **during** the invocation and kills the process
on breach — the interrupted turn is discarded per §11.2 and the task fails with the budget
error. The CLI's own budget flag is passed as belt-and-suspenders only; Marathon's
enforcement never depends on it (`claude-code-impl.md` §4.3).
