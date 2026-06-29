# 28. Meta-harness organ map

Marathon is a **meta-harness** — a Layer-2 *harness orchestrator*. It does not try to be the
best single agent; it drives agents through a uniform seam, isolates and governs them, and runs
them in a durable **loop**, keeping a human in the right seat. This section maps that anatomy
onto Marathon's components and specifies the **orchestration loop** that ties them together.
(Framing — "the seven organs," and "the value moved up a layer, from the harness to the layer
that governs many of them" — is adapted from Egor Pushkin's third-party *meta-harness* essay
series; the original is a copyrighted article and is **not** reproduced in this repo.)

## 28.1 The seven organs in Marathon

| Organ | Marathon component(s) | Status |
| --- | --- | --- |
| **1 Adapter** — one interface over heterogeneous harnesses (typed session/events, not screen-scraping) | `AgentRuntime` seam — `PiAgentRuntime` (in-process Pi SDK), `FakeAgentRuntime` | Built for **one** harness; a **2nd adapter is planned** (§28.3) |
| **2 Router** — pick the agent/harness by capability/cost/track-record (+ model routing) | `InvocationRouter` + `selectAgent` (capability/keyword); model routing via `model-gateway` (§7.19) | Agent routing built; cost/track-record + multi-harness later |
| **3 Isolation & parallelism** | `DockerSandbox`/`DockerContainer` + `Workspace` (§12.6); durable queue (concurrent workers) | Isolation **strong**; spend-to-search / merge-queue later |
| **4 Coordinator** — who does what, handoffs | **Folded into the loop** — the frontier orchestrator chooses sub-agents/tools (§28.2) | By design, part of the loop; explicit A2A later |
| **5 Governor** — policy / approval / budget / audit, **enforced at the tool-call boundary** | `ToolGateway` (§7.8), destructive-only approval (§7.9), budgets (M8), append-only audit, tenant isolation, redaction | **Strong — the moat** |
| **6 Work source** — intake + proof | Slack + GitHub surfaces & webhooks (§7.1, §7.17); proof = PRs + the task timeline (§16.3) | Built (mention/webhook); board-polling intake later |
| **7 Loop** — plan → act → verify → repeat to done | **The orchestration loop (§28.2)** | **Designed here, built in M11** |
| **State** (substrate, not a peer organ) | Durable task spine, per-step checkpoints, model/tool/audit logs, timeline (§11, §16) | **Strong** |

Marathon is strongest exactly where the essay says the moat forms — the **governor** and
**state** — and is a **single-harness, governed, durable** orchestrator (human *in* the loop for
destructive actions, *on* the loop for safe ones).

## 28.2 The orchestration loop

On invocation Marathon does **not** run a single agent turn. It runs a **frontier-orchestrated
loop**: a frontier "lead" model designs and validates the work; cheaper sub-agents execute it
under isolation and governance. The **coordinator** organ is folded in here — choosing the
sub-agent(s) is the lead's job.

**Workflow**

1. **Invoke** — Marathon is tagged in Slack or a GitHub issue/PR comment. The surface gateway
   normalizes it into a **durable task** (§7.16, §7.1, §7.17).
2. **Understand** — assemble context (§7.18) and **recall memory** (§7.12) to establish the
   goal, constraints, and any prior corrections.
3. **Plan** — the **frontier orchestrator** (reasoning tier, §7.19) reads goal + context +
   memory and produces (a) a **plan/loop**: the **success criteria**, the iteration shape, and
   which **sub-agent(s) and tools** to use; and (b) the **sub-agent prompt** handed to each
   worker iteration. This is also the **trust-hierarchy sanitization point** (§12.2): the
   frontier model converts untrusted surface/document content into a *clean* sub-agent prompt.
4. **Loop** — repeat until done or a cap is hit:
   - **Execute** — a **sub-agent** runs the harness (`AgentRuntime`, §7.5) with the sub-agent
     prompt + context, in the **sandbox** (§12.6), using **governed tools** (§7.8); destructive
     actions gate on **approval** (§7.9).
   - **Verify** — the **frontier orchestrator validates** the output against the success
     criteria, plus **objective checks where available** (tests / type-checks / build run as
     sandboxed tools — the tightest, cheapest signal). Verdict: **done**, **continue** (refine
     the prompt/context with feedback and iterate), or **escalate** (ask a human).
   - **Ground & bound** — state is carried in the **workspace + checkpoint + memory**, not just
     chat history (each iteration may start with fresh context to avoid drift past
     ~100–150k tokens). **Exit detection** = the verifier's done-signal; **caps** = max
     iterations + the spend budget (M8). These guard the two classic loop failure modes:
     looping forever (no exit detection) and drifting (no grounding).
5. **Report** — deliver the result + a **loop summary** (what was done, iterations, cost) to the
   originating surface(s) (§15), and write durable learnings/corrections to **memory** (§7.12).

**Two model tiers (spend-to-search).** The orchestrator (plan + verify) uses a **reasoning-tier**
model; sub-agents (execute) use the **default/cheap** tier (§7.19). A smart lead spends many
cheaper sub-agent attempts and keeps what verifies — "many cheap tries beat one perfect run."

**Durability.** Each loop iteration is a checkpointed `TaskStep` (§11.2): the plan, success
criteria, iteration index, and verifier verdicts live in the checkpoint, so a crashed worker
**resumes mid-loop, exactly-once** (§11.3).

**Escalation = durable human wait.** "Escalate to a human" is the block-persist-resume approval
(§7.9, §11.6, M10): the loop blocks, persists, posts the ask in-thread, and resumes on the
human's answer.

**Where the organs meet in one run:** *work source* (1) feeds the task → *router* picks the
agent → the *frontier orchestrator* plans the *loop* (7) and acts as *coordinator* (4) →
sub-agents execute in *isolation* (3) via the *adapter* (1) under the *governor* (5) → verify →
report, with everything written to *state*.

## 28.3 Gaps & direction

- **Loop (#7)** — specified here; built in **M11** (frontier plan/verify + sub-agents).
- **Adapter breadth (#1)** — add a **second harness** behind `AgentRuntime` (e.g. Claude Code or
  Codex) to prove "harnesses are replaceable." Tracked in the roadmap.
- **Coordinator (#4)** — folded into the loop for now (the frontier model chooses sub-agents);
  explicit agent-to-agent messaging (A2A) is a later, separate capability.
- **Parallelism (#3)** — spend-to-search (N attempts → score → keep best) and an N-agent merge
  queue are later; today the loop is sequential with PR-serialized writes.
- **Behavioral identity (governor, #5)** — "is this agent behaving as this actor should?" — far
  future; must stay **purpose-bound to the task/mission, not the person** (§12).
