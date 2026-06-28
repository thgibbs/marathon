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

Agents should be treated as untrusted actors. All tool calls run through the **Pi harness's tool layer**, which enforces Marathon's permissioning before any side effect — the model proposes a tool call, but the harness (not the model) decides whether it runs.

The model should not directly receive secrets.

The model should not directly execute arbitrary privileged actions.

Policy is enforced outside the model: Marathon defines the tool policy and credentials; Pi enforces them on every call; neither the model nor the agent can alter or bypass them.

---

## 5.4 Human approval for risky actions

Read-only and non-destructive write actions can run automatically. **Only destructive, irreversible, or externally-irreversible actions require approval** — the gate is "destructive," not "write."

Examples that **require** approval (destructive / irreversible / external):

* Merge a PR
* Delete an issue
* Modify a database row
* Send an external email
* Trigger a deployment
* Rotate a secret

Examples that **do not** require approval (non-destructive, easily reversible):

* Create a GitHub PR
* Comment on an issue or PR
* Post to a public channel
* Change incident status

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
