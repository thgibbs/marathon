# 5. Product principles

## 5.1 Meet users where work happens

Marathon should feel native to whichever surface the user is on — **Slack and GitHub-backed markdown documents from day one**, others later. The user should not need to open a dashboard for normal use.

**Documents are how work gets done.** A common pattern: an agent sees a Slack request, drafts a **design document** describing the work (as a markdown pull request), lets people comment on and approve it, and only then starts executing the task. The document is the durable plan of record, not just an output (see §6.8).

On any surface, agents should:

* Reply in the native thread (a Slack thread, a document comment thread)
* Preserve context
* Offer lightweight feedback (👍/👎 in Slack, comment reactions elsewhere)
* Post progress updates
* Ask clarifying questions
* Respect the surface's permissions (channel membership, repository permissions)
* Avoid noisy behavior

Slack-specific behaviors are properties of the Slack surface, not of the platform core.

---

## 5.2 Durable by default

Every invocation should become a persisted task.

The system should record:

* Who invoked it
* Where it was invoked
* What agent handled it
* What model was used
* What tools were called
* What context was loaded
* What outputs were generated
* What feedback was received
* What errors occurred

---

## 5.3 Secure by construction

Agents should be treated as untrusted actors. Every governed tool call executes in Marathon's **`ToolGateway`** — a host-side chokepoint outside the model. Pi runs the agent loop; the gateway does the mechanical plumbing: tenant credential selection + injection, a ledger of what the task has read, egress routing (§7.8), output redaction, audit, caps, and a kill switch.

The model should not directly receive secrets.

The model should not directly execute arbitrary privileged actions.

*What an agent may do* is enforced by construction, not by a policy engine: the **credential's scope** (least-privilege, tenant-owned), the **resource's own permissions** (branch protection, repo/DB roles), and the **egress policy** (§7.8) — with high-risk effects only proposable, never direct (§7.9). *Which tools an agent has at all* is fixed at construction time (tool registration), not decided at runtime. Neither the model nor the agent can alter or bypass any of it.

---

## 5.4 Human review for high-risk effects

There is no single "destructive" flag. Effects are classified on several axes — **reversibility, trust-boundary crossing, audience, and cost** (§7.8) — and routed by risk:

* **Autonomous** — reversible, no trust-boundary crossing, bounded audience: read, create a branch, open a PR, reply in the originating thread.
* **Native review** — where the surface has a draft/review mechanism, prefer it: the agent opens a PR, a human merges; the merge *is* the approval.
* **Proposed Effect** (§7.9) — high-risk effects (irreversible, cross-trust-boundary, public/external, or costly) are never direct tools: the model *proposes* the exact artifact, an authorized human reviews it, and a non-model executor performs it.

Examples that route to **native review or a proposal**:

* Merge a PR (native: branch protection + a human merge)
* Delete an issue (irreversible)
* Modify a database row (irreversible)
* Send an external email (external audience)
* Trigger a deployment (irreversible, costly)
* Rotate a secret (irreversible)
* Tenant-external egress — external/shared channels, external email, public artifacts derived from restricted sources (§7.8)

Examples that run **autonomously** (reversible, bounded audience):

* Create a GitHub PR or branch
* Comment on an issue or PR in the repo the task is working in
* Post a status update or clarifying question in the originating thread
* Post findings to an internal channel when the requesting user has access to the task's sources (the default *on-behalf-of* egress policy — §7.8)
* Change incident status

And one outcome is stronger than a proposal: disclosure beyond the requesting user's own access is **denied** under the default egress policy — an approver cannot extend access the requestor lacks (§7.8).

> **Approval fatigue is a design force** (§7.8): maximize native handoff and autonomous-safe; keep in-app approval rare.

---

## 5.5 Inspectability over magic

Users and admins should be able to inspect what happened.

For every task, Marathon should make it possible to answer:

* What did the agent do?
* Why did it do that?
* What tools did it call?
* What data did it see?
* What did it cost?
* Where did it fail?
* Which prompt/model version was used?

Marathon should provide an **inspectability dashboard** that surfaces this per-task timeline — model calls, tool calls, data seen, cost, failures, and prompt/model versions — for users and admins.

---

## 5.6 Cheap when possible, smart when necessary

Not every step needs the most expensive model.

Marathon should make model routing a core platform feature, not an afterthought.

---

## 5.7 Open and extensible

The platform should be built around stable extension points. In the initial product, **tools are the one externally-extensible point** (via MCP servers and command-line tools); everything else is extended internally by the Marathon team for now:

* New tools — **external** (MCP servers, command-line tools)
* New models — internal
* New connectors — internal
* New storage backends — internal
* New agents — internal
* New deployment targets — internal
* New evaluation strategies — internal
