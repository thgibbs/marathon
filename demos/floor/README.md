# demo-floor — the trust-profile floor contract

This is the **named floor** of the trust-profile model ([`design/30-trust-profiles.md`](../../design/30-trust-profiles.md) §30.3),
written down as an executable contract. The floor is **invariant in every profile**
(`solo` → `team` → `org` → `hosted`) and is **not overridable** by any profile or
knob. Together the eight invariants are precisely the solo developer's stated
requirement set: *no exfiltration of secrets, and no destructive action without
permission.*

Run it:

```
make demo-floor
```

It is fully in-memory — **no Postgres, no Docker** — and exercises the real
mechanisms (the `ToolGateway` chokepoint, the command broker, the
`ProposedEffectService`, the budget evaluator), so a regression in the floor
fails here. Each case prints `[floor] N …`; the suite ends with `demo-floor OK`.

## The eight invariants → cases

Each row maps a §30.3 invariant to the case in [`run.ts`](./run.ts) that asserts it.

| # | §30.3 invariant | Case asserts | Mechanism under test |
| --- | --- | --- | --- |
| 1 | Tool/tenant credentials never enter the sandbox or model context | host secrets are not inherited by a brokered child; the credential reaches the child via env injection only, never in argv | `ExecFileCommandRunner` / `BASE_ENV_KEYS` (`command-broker.ts`) |
| 2 | Secret redaction on every boundary crossing | the recorded input, output, and error summaries are all redacted | `ToolGateway.run` → `redactSecrets` (`gateway.ts`, `redact.ts`) |
| 3 | All code execution in a sandbox; no implicit host shell | `cli.run` with the default `NoSandbox` refuses (fail closed) | `makeCliTool` / `NoSandbox` (`cli.ts`, `sandbox.ts`) |
| 4 | No irreversible/destructive effect without an explicit human act | a granted destructive tool routes to a proposal (never a direct call); approval binds to the exact payload hash; execution is at-most-once | gateway `requires_proposal` + `ProposedEffectService` (`effects.ts`) |
| 5 | Tenant-leaving egress is never autonomous | external egress is **refused** (not proposed — that route lands with M10) and audited; a restricted-source read blocks even internal egress | `ToolGateway` egress routing / `checkEgress` (`gateway.ts`) |
| 6 | Audit event per governed effect (and per denial) | a governed effect emits `tool.called`; a denial emits `policy.denied` | `ToolGateway.audit` (`gateway.ts`) |
| 7 | Hard budget cap, fail-closed at turn boundaries | a run over its cap is killed; a non-positive cap denies all spend (never silently "unlimited") | `assertWithinTaskBudget` / `evaluateBudget` (`budget.ts`) |
| 8 | Untrusted-content fencing in prompt assembly | forged fence markers inside untrusted content cannot escape the fence | `fenceUntrusted` (`core`, §12.2) |

## The two stated residuals (documented, not asserted as leaks)

§30.3 states two residuals honestly rather than hiding them. They are **not** floor
violations — they are known, scoped, and tracked in §30.9 — so this suite does not
assert them as leaks:

1. **Model-credential carve-out under Claude Code `bridge`.** That harness calls the
   model itself, so the API key / subscription token enters the container env
   (`modelAccessEnv`), guarded by redaction. Proxy-only model access is the locked
   posture and becomes floor at `hosted`. Until the internal-network model proxy
   lands (K7 spike), this is the floor's one scoped carve-out.
2. **Repo-text egress under the default `bridge` sandbox network.** An injected
   agent's *code* could POST workspace contents outbound — credentials are
   floor-protected everywhere; repo text under `bridge` is not. This is the OQ-4
   "company-viewable" calibration applied to a repo whose company is you. Lockdown
   (`sandbox.network: none`) exists today for Pi; for Claude Code it is rejected
   fail-closed at wiring until the proxy path lands.

## Relationship to `demo-m9`

`demo-m9` is the defense-in-depth / prompt-injection demo and overlaps several floor
cases (destructive-blocked, fencing, redaction, sandbox-mandatory, tenant isolation).
`demo-floor` is the **complete, one-for-one** statement of the §30.3 contract — it
adds the cases m9 lacks (broker credential isolation, egress refusal + audit, the
proposal payload-hash/at-most-once lifecycle, the budget kill) and exists to be the
regression suite the floor is measured against. The container-level end-to-end proof
that *no credentials enter a real sandbox* lives in `demos/m9/smoke-sandbox-broker.ts`
(requires Docker); demo-floor asserts the same broker mechanism deterministically.
