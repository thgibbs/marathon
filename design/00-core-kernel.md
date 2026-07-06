# 0. The core kernel

> **Read this first.** Marathon is a startup product being built from the ground up: no
> customers yet, nothing proven. It succeeds or fails on **one loop being genuinely useful**.
> Everything else in this design guide is real and stays planned — but nothing may add steps,
> latency, prompts, or setup friction to this loop. This section is the prioritization lens
> over the whole corpus: what must **work correctly** for the first customers, what ships
> **deliberately minimal**, and what is **explicitly deferred**. It does not need to be
> enterprise-ready on day 1 — no SOC 2, no SSO, no multi-tenant hardening. It needs to work,
> be super easy to use, and make life better.

## 0.1 The loop

```text
1. ASK      @marathon in Slack: "ship rate-limiting for the public API"
      |
2. DRAFT    the agent writes a design document — a markdown PR in the repo
      |
3. ITERATE  people comment on the doc PR and reply in the Slack thread;
      |     the agent revises the doc and asks clarifying questions
      |
4. BUILD    a human merges the doc PR into the PLANS branch (the merge IS
      |     the approval — §29.1a; main is untouched); the agent implements
      |     the plan — sandboxed code edits, tests run
      |
5. DELIVER  the agent opens a code PR carrying code + the plan doc together,
            posts the link + summary back to the Slack thread and the doc;
            a human reviews and merges — only then does the plan reach main
```

This is §6.8 (document-driven execution) plus one emphasis the corpus underweights: **the
agent writes code**, so the sandboxed code path (§12.6 Pattern 2) is kernel, not hardening.
The loop's every approval is **native** (a PR a human merges) — the kernel needs **zero
in-app approvals**, which is what lets so much be deferred.

## 0.2 Kernel — must work *correctly* (not just demo)

| Loop stage | Feature | Design | Status |
| --- | --- | --- | --- |
| all | Durable task spine: queue, checkpoint, resume, idempotency | §7.4, §11 | built (M1) — resume of a *real* multi-turn run is a gap (K4) |
| all | Agent harness behind `AgentRuntime` — **Pi** or **Claude Code headless**, one per deployment; fixed default model; per-call cost capture | §7.5, §9.2 | Pi built (M2); Claude Code = K7 |
| all | `ToolGateway` plumbing: tenant creds host-side, redaction, audit | §7.8, §9.2 | built (M3/M6.1) |
| 1 | Slack: Socket Mode, mention → task, ack, threaded replies, progress | §7.1, §15 | built (M4/M5.5) |
| 2 | `document.*` tools: create/update via branch + PR; SHA idempotency | §7.17, §14.6 | built (M6) |
| 3 | Doc-PR comments revise the draft on its branch (`document.revise`) | §6.8, roadmap M7 | built |
| 3 | Thread continuity: replies with thread context + thread memory; clarifying questions = ask, end turn, new task on the reply (§11.6 async shape) | §7.12, §7.18, §11.6 | built (M7) — verify against the loop (K3) |
| 4 | Merge webhook = approval → execution task spawns | §6.8 | built (M6) |
| 4 | Sandboxed code work: ephemeral workspace, `bash/read/write/edit` in the container, creds never inside | §12.6 | built (M9 Pattern 2) — not stitched end-to-end (K1) |
| 4 | Verification inside the session: the agent runs tests/build via sandboxed `bash` before opening the PR | §28.2 (verifier) | Pi's in-session loop suffices — **no M11 machinery needed** |
| 5 | The handoff contract: `github.submit_code_changes` → `marathon/` branch → code PR; PR link + summary delivered to the Slack thread *and* the doc PR | **§29**, §10.8 | gap (K1, K2) |
| all | Inspectability data: per-task timeline, cost | §8.5, M8 | built (API); UI deferred |
| all | Quickstart: compose up → YAML agent → Slack + GitHub apps → first loop | §2.7, §6.2 | gap (K6) |

**The kernel's security floor** (kept because it's cheap, built, and the differentiator):
sandbox for all code execution, credentials never in the sandbox or the model, output
redaction, untrusted-content fencing, audit log. Everything *policy-shaped* beyond that is
simplified below.

## 0.3 Kernel gaps — the actual work list

> Milestone form (goals, prerequisites, exit demos): **roadmap §2c** (K1–K6).

- **K1 — Code-writing path end-to-end.** Implements the **execution contract in
  [[29-code-handoff]]** — the product's central path, specified, not glue: pinned
  `base_sha` (default-branch head at approval; the plan itself is pinned separately by
  `plan_ref` on the plans branch — §29.1a) → host-materialized, credential-stripped workspace →
  sandboxed edits + verify (repo `verify:` config → plan's Verification section → judgment)
  → the single `github.submit_code_changes` handoff, whose **diff the gateway reads from the
  workspace itself** (protected-path + secret + size checks) → `marathon/<task>-<slug>`
  branch → code PR (draft + `marathon:unverified` if red at the cap). Proof: merged plan in,
  green-tested code PR out, live.
- **K2 — Loop task chain + `delivery_targets`.** The merge-spawned execution task must
  inherit `delivery_targets = [originating Slack thread, doc PR]` (§10.8) so progress and the
  final PR link land in both places. This is task-chain plumbing — it needs **no identity
  linking**.
- **K3 — Iteration continuity, verified.** Thread replies and doc comments must reliably
  continue the conversation (thread memory + context builder are built; test them against
  this loop specifically, including the ask-a-clarifying-question → user answers → work
  continues path).
- **K4 — Durable resume of a real run** (roadmap §2b #4). A worker crash mid-code-writing
  must resume from the per-turn checkpoint, not restart. Long BUILD stages make this kernel.
- **K5 — Status visibility.** `@marathon status` in-thread (§15.3) + the silent cost footer.
  A loop that spans hours-to-days must never leave the user wondering if it's alive.
- **K6 — Quickstart.** `git clone → docker compose up → YAML agent → install Slack app +
  GitHub App → first loop` in under ~30 minutes, with one **flagship agent** whose persona
  spans the whole loop (draft docs *and* write code — defined in [[21-example-agents]]
  §21.0). Easy-to-use is a kernel feature, not packaging.
- **K7 — Claude Code harness (headless).** The second `AgentRuntime`: `claude -p` as a
  sandboxed subprocess (Pattern 1, §12.6), governed tools via an MCP shim over the host
  broker, a host-side key-injecting model proxy on an internal-only network, session state
  in the workspace home, `--resume` checkpointing with `--max-turns`-bounded turns —
  selectable per deployment (`harness: pi | claude-code`). Full integration reference:
  `claude-code-impl.md`. Done when the K1–K4 demos re-run green under
  `harness=claude-code`. **Not required for the §0.6 bar** — first blood ships on one
  harness (the already-integrated Pi); K7 lands in parallel or after, without blocking the
  ratchet.

## 0.4 Deliberately minimal in the kernel

| Area | Kernel version | Full design (kept, deferred) |
| --- | --- | --- |
| Agents | **one flagship agent** (Forge — [[21-example-agents]] §21.0), YAML-defined | registry, discovery, default-agent selection (§7.2–§7.3) |
| Repos | **one configured target repo** per deployment (the dogfood repo) | multi-repo + the project resolver (§7.12) |
| Harness | one of **Pi** or **Claude Code (headless)** per deployment (`harness:` in the YAML — §7.5, K7) | router picks the harness per task (§28 organ #2) |
| Approvals | **native-only** (doc PR merge, code PR merge) | Proposed Effects + Agent Hub (§7.9, M10) |
| Egress | OQ-4 calibration: repos company-viewable; **external egress simply not wired** (no external-channel or email tools registered) | full egress policy modes + deny path (§7.8) |
| Memory | thread short-term + task summaries to project scope | audience-gated recall, corrections, promotion gates (§7.12, §2b #9) |
| Models | one fixed default model + a hard per-task cost cap | routing, tiers, fallback, budgets (§7.10, §7.19, §13) |
| Identity | none needed — approvals are GitHub-native, egress calibrated | §7.20 linking (activates with M10 / restricted tiers) |
| Admin | timeline API + logs | console + dashboards (§7.13, §16) |
| Cancellation | task timeout + gateway kill switch | user-initiated cancel (§15.4) |

## 0.5 Explicitly out of the kernel (planned, and must stay out of the way)

**M10** (Proposed Effects / Hub — the loop has no in-app approvals), **M11** (orchestrated
loop — Pi's in-session iterate-with-tests covers the kernel's verify needs; revisit when
tasks outgrow one session), **§2b #9** (memory refactor), **§2b #10** (identity linking),
multi-tenant enterprise features, SSO/SOC 2, evals (OQ-8), retention (OQ-6), microVM backend,
OTel export, additional surfaces/providers, MCP breadth. Each keeps its design; none may add
a step, a prompt, or a setup requirement to §0.1.

## 0.6 The bar: Marathon codes Marathon

The kernel is done when **we use Marathon to build Marathon** — the loop, run against this
repo, is how changes get made:

> Ask in Slack → the agent drafts a design-doc PR in the `marathon` repo → we comment, it
> revises and asks clarifying questions → we merge → it implements in the sandbox, runs the
> test suite (`vitest`, the `make demo-*` regression demos), and opens a code PR → we review
> and merge.

Dogfooding is the bar because it makes every kernel gap **self-enforcing**: whatever is
broken, slow, confusing, or unsafe in the loop, we hit it before any customer does — and this
repo has exactly the objective verifier (a real CI suite) the BUILD stage needs.

The ratchet, in order:

1. **First blood** — one nontrivial, Marathon-authored change to Marathon merges to `main`
   through the full loop.
2. **Habit** — the loop is the *default* path for changes to Marathon; hand-written PRs are
   the exception that needs a reason.
3. **Ready** — a stranger reaches the same loop on their own repo from `git clone` in under
   ~30 minutes (K6).

Beneath the lived bar, one scripted proof stays as the CI regression guard:

> `make demo-kernel` — a Slack ask produces a design-doc PR; a review comment produces a
> revision; a clarifying question gets asked and answered in-thread; the merge triggers
> implementation; the agent edits code in the sandbox, runs the tests, and opens a green code
> PR; the PR link and summary appear in the Slack thread and on the doc. Kill the worker
> mid-BUILD and it resumes.

Only when the loop is how Marathon itself gets built does the deferred list start competing
for time again.
