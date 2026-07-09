# 29. The code-writing handoff (BUILD → DELIVER contract)

This is the execution contract for the kernel loop's BUILD and DELIVER stages (§0.1):
**approved plan in → green-tested code PR out**. It is the product's central path, so it is
specified concretely — not left as glue. Implemented by **K1/K2** (roadmap §2c).

Two principles shape everything below:

1. **The workspace is the artifact.** The agent's work product is the state of the sandboxed
   working tree — not text it emits. The handoff **reads the diff from the workspace**
   (host-side); the model never passes file contents through the handoff tool, cannot
   misrepresent what changed, and large diffs never transit model context.
2. **Harness-agnostic by construction.** The whole contract is governed tools + workspace
   conventions. Pi attaches the tools as custom tools; Claude Code gets them as MCP tools
   over the broker (§7.5, §7.8); the workspace mount and `bash/read/write/edit` semantics are
   identical (§12.6). Nothing here branches on the harness.

## 29.1 Trigger and task input

Plan documents open as **draft PRs against the default branch** (§29.1a — decision
2026-07-08, supersedes the plans branch). A human's **approving review** on the draft doc PR
is the approval; the `pull_request_review` webhook (state `approved`, on a Marathon-owned doc
PR, from an approver with **write access**) spawns the **implementation task**:

```text
plan_ref            = { repo, doc_path, approved_sha }       # the plan, at its approved version
                                                             #   (the doc-PR head at the review)
base_sha            = approved_sha                           # the work builds ON the doc branch
branch              = <the doc-PR branch>                    # pushed back onto — same PR
delivery_targets    = [ originating Slack thread, doc PR ]   # inherited via the task chain (K2)
idempotency_key     = (repo, doc_path, approved_sha, "implement")
```

* `plan_ref` is **pinned to the doc-PR head SHA at the moment of the approving review**:
  deterministic, auditable, content-addressable forever (git history is the record), and
  voided by revision — a plan revised and re-approved has a **new** head SHA → a new task.
* `base_sha` **is** `approved_sha`: the workspace is the doc branch itself, checked out at
  the approved tip, so the plan doc is **already in the tree** at its `doc_path` — the agent
  reads it with its own file tools, no side-channel plan delivery, and the implementation
  commits land on the same branch (the design PR updates in place).
* One implementation task per approved plan version: a re-delivered webhook is a no-op; an
  approving review that arrives after the implementation already landed on the PR (a
  `CodeChange` exists for it) is ordinary pre-merge code approval and spawns nothing.
* A merged doc PR is the **ship**, not the approval: the merge webhook only records the
  merge commit and completes bookkeeping. A doc PR merged without ever being approved is
  "shipped without a build" — the doc task completes, and NO implementation spawns; approval
  is always the explicit review, never implied by a merge.

## 29.1a The combined PR — one PR ships design + code

**Decision (2026-07-08, supersedes the plans branch / merge-as-approval of 2026-07-04).**
The plans-branch flow required a dedicated long-lived branch, a two-PR lifecycle (doc PR into
the plans branch, then a separate code PR into main), and bootstrap provisioning. The
combined-PR flow collapses that into GitHub's native draft → approve → ready → merge
lifecycle:

* **Doc PRs open as DRAFTS against the default branch.** The draft state is GitHub's native
  "not ready to merge" marker, so an unimplemented plan cannot be merged by muscle memory;
  review UX, CODEOWNERS, and branch protection apply unchanged.
* **The approving review is the approval — and the approver's write access is the
  load-bearing check.** On a public repo GitHub lets ANYONE submit an approving review (it
  only gates *merging* on write access). Since the review is what triggers a sandboxed build,
  Marathon verifies the approver holds **write (or admin) permission** on the repo (the
  collaborator-permission endpoint) before spawning the implementation task; anything less is
  silently ignored. The approval stays native, deliberate, and sha-pinned (§7.9) — the
  webhook carries the PR head SHA, which becomes `plan_ref.approved_sha`.
* **The BUILD agent implements on the SAME branch — and the gateway enforces it.** The
  workspace is the doc branch at the approved tip; the agent commits its work there and
  pushes back through the brokered `git.exec` (fast-forward — force pushes are
  unrepresentable through the broker). The same-PR invariant is NOT left to the prompt:
  the BUILD binding carries the task's one expected PR number + head branch, and
  `delivery.report_pr` **refuses** (typed `PR_MISMATCH`, agent-visible so a retry
  self-corrects) a report of any other PR or branch — an agent that opens a fresh
  same-repo PR cannot be recorded or delivered as success while the approved draft sits
  unimplemented. The kernel BUILD grant carries no `pr create` at all.
* **`delivery.report_pr` is the single authority for the PR's draft/ready state.** Green
  reported verification marks the combined PR ready for review; red or missing
  verification converts it (back) to draft — a premature `gh pr ready` (not granted to
  the kernel agent, but available for operator grants) cannot leave a red combined PR
  mergeable past the report. Marathon's recorded state and GitHub's never diverge.
* **Merging the combined PR ships design + code atomically.** The default branch keeps the
  invariant: **a plan doc on main means the plan shipped, with its implementation.** If
  review forces divergence from the approved plan, the agent amends the doc on the branch —
  what merges is the **as-built** plan, not the as-hoped one.
* **An abandoned plan is a closed draft PR.** Never approved, or closed unmerged — nothing
  reaches main. Closed PRs are the ledger of everything considered.

Alternatives considered and rejected: the plans branch (decision 2026-07-04 — a second
long-lived branch to provision, protect, and explain; a two-PR lifecycle where the plan
reaches main only via a *different* PR than the one that was approved); merge-to-main +
cleanup (transient litter, churn commits); a separate plans repo (cross-repo credentials,
fights the K6 thirty-minute setup). The earlier objection to approve-via-review ("weaker
ritual, no canonical merged plan") is answered by the combined PR itself: the ritual is the
same native review flow every code change gets, the canonical plan is the doc at
`approved_sha` (and, once shipped, on main), and the write-access gate keeps the signal as
strong as a merge. Recorded in `open-questions.md` (OQ-9).

## 29.2 Workspace lifecycle

1. **Provision** the sandbox (pinned toolchain image digest — K1 prerequisite).
2. **Materialize** the workspace **host-side**: clone the repo and check out `base_sha`
   (detached) — the approved doc-PR head, so the plan doc is **already in the working tree**
   at its `doc_path` (§29.1a; a defensive fallback re-writes it, a no-op when present) —
   then **strip remotes and credential helpers** before mounting at `/workspace`. The clone
   is a governed read (recorded in the source ledger, §7.8); the sandbox never fetches — its
   only exits are the broker socket and, for Claude Code, the model proxy on the
   internal-only network (§12.6).
3. The agent **works**: edits files, runs commands via sandboxed `bash`. Local `git` use
   (commits, branches) is allowed as the agent's own scratch discipline but is **advisory** —
   the authoritative artifact is the final working tree. (Exporting the agent's commit series
   as the PR's commits is a post-kernel nicety.)
4. **Per-turn checkpoints (K4):** each turn snapshots `git diff base_sha..worktree` alongside
   the session checkpoint; resume re-materializes (fresh clone at `base_sha` + apply the
   snapshot) and continues.
5. **Teardown** always destroys the sandbox and workspace; nothing persists locally. The only
   durable outputs are the pushed branch, the PR, and the task records.

## 29.3 Verify

The agent must attempt verification before handing off. The verify commands come from, in
precedence order:

1. Repo config: a `verify:` command list in `.marathon/config.yml` (if present);
2. The plan doc's own **Verification** section (the plan says how to prove it);
3. Agent judgment (`make test`, `pnpm test`, …).

Rules:

* The in-session loop is the verifier: implement → run → fix → re-run until **green** or the
  iteration/spend cap (no M11 machinery — §0.2).
* **Green → ready PR. Not green at the cap → the work is still delivered** as a **draft PR**
  labeled `marathon:unverified`, with an honest failure summary. Losing work is worse than
  shipping a draft; lying about test state is worst of all.
* **Draft-tracks-verification is enforced, not requested:** `delivery.report_pr` sets the
  PR's GitHub draft/ready state from the reported verification (green → ready; red/missing
  → converted back to draft, even after a premature model-driven `pr ready`). The recorded
  `CodeChange` state and GitHub's PR state cannot diverge.
* Every command run, exit code, and a size-capped output summary is recorded on the task and
  echoed in the PR body.

## 29.4 The handoff tool — `github.submit_code_changes`

One governed tool ends the BUILD stage:

```text
github.submit_code_changes(
  title,           # PR title
  summary,         # what was done and why (PR body)
  plan_ref,        # echoed { repo, doc_path, merge_commit_sha } — the argument keeps its
                   #   legacy name; it carries plan_ref.approved_sha (§29.1a) and the
                   #   gateway validates it matches the task
  verification,    # [{ command, exit_code, summary }] as run in-session
  open_questions?, # surfaced in the PR body
  draft?           # may request draft; FORCED true when verification isn't green
)
```

Note what is absent: **no diff, no file list, no patches.** The gateway reads the truth from
the workspace.

**Gateway algorithm** (deterministic; every failure is a *typed, agent-visible error* so the
agent can correct course in-session):

```text
1. validate: schema; tool registered for this task; task is in its BUILD stage;
   plan_ref matches the task's plan_ref
2. capture: diff = git diff base_sha..worktree   (host-side, from the mounted workspace)
3. check:
   - diff is non-empty and within caps (files / lines / bytes)          → DIFF_TOO_LARGE / EMPTY
   - no changes under protected paths — `.github/workflows/**` and the
     tenant-configured list are REFUSED by default (CI config is a
     privilege-escalation vector: workflows run with repo secrets)      → PROTECTED_PATH
   - secret scan on added lines (known patterns)                        → SECRET_IN_DIFF (redacted pointer)
   - target namespace is marathon/* ; never the default branch          → (enforced, not an agent error)
4. commit: host-side, author = the Marathon bot, message = title +
   plan reference + trailer `Marathon-Task: <task_id>`
5. push: branch `marathon/<task_id>-<slug>` with the tenant App
   installation token (credentials never in the sandbox),
   `--force-with-lease` — a task owns exactly its own branch
6. PR: create-or-update against the default branch; draft per §29.3;
   idempotent on (task_id, tree_hash) — same tree twice is a no-op
7. record + audit; return { pr_url, branch, commit_sha, state }
```

## 29.5 Branch, commit, and PR conventions

* **Branch:** `marathon/<task_id>-<slug>` — the `marathon/` prefix is the gateway-enforced
  namespace (§7.8); deterministic per task, so retries and revisions converge on one branch.
* **Commit:** bot-authored, single squashed commit; `Marathon-Task:` trailer links git
  history back to the task timeline (§16.3).
* **PR body template:** summary → **plan link** (`doc_path` @ `approved_sha`) →
  verification results (commands, pass/fail) → open questions → Marathon task link
  (inspectability) → provenance footer. The PR *is* the review surface; it must carry
  everything a reviewer needs without opening Marathon.

## 29.6 Delivery and revisions

* On success the structured result (PR link + summary + verification state) is delivered to
  **every `delivery_target`** — the originating Slack thread and the doc PR (K2).
* **Revisions:** an `@marathon` comment on the *code* PR spawns a revision task (K3
  machinery) that pins `base_sha` = **the task branch's current tip**, works in a fresh
  workspace, and hands off through the same tool — appending to the **same branch and PR**.
  A revision that diverges from the approved plan **amends the plan doc on the code branch**
  (§29.1a): the doc that merges with the code is the as-built plan.
* **Merge conflicts** with a moved default branch are the reviewer's signal, not something the
  kernel auto-rebases: GitHub shows the conflict; a human (or an explicit `@marathon rebase
  this` revision task) resolves it. Honest and simple; auto-rebase is post-kernel.

## 29.7 Failure modes

| Failure | Contract |
| --- | --- |
| Diff too large / empty | typed error → agent narrows scope or splits the work in-session |
| Protected path touched | typed error naming the path; tenant may explicitly enable |
| Secret detected in diff | typed error with a redacted pointer; agent removes and resubmits |
| Verify red at the cap | draft PR + `marathon:unverified` + honest failure report (§29.3) |
| Worker/sandbox dies mid-BUILD | K4 resume: fresh clone at `base_sha` + turn diff snapshot |
| Duplicate submit (same tree) | idempotent no-op; same PR returned |
| Webhook re-delivery | idempotency key → no second implementation task |
| Default branch moved (conflict) | surfaced on the PR; human or explicit revision task resolves |

## 29.8 What is recorded

A first-class **`CodeChange`** record (§10.19) — one per implementation task, updated by
revisions — captures `plan_ref`, `base_sha`, `branch`, `tree_hash`, `pr_url`, `state`, and
the verification results. Per handoff: a `ToolInvocation` plus audit events
(`workspace.materialized`, `code.submitted`, `pr.opened` / `pr.updated`). The workspace clone
is a ledger entry (§7.8); the PR itself carries the human-facing provenance (§29.5). Resume
semantics for a crash mid-BUILD are specified in §11.2 (turn atomicity; containers never
recovered; convergent handoff).

## 29.9 Effect classification

`github.submit_code_changes` is **reversible with a native review surface** → default mode
**native review** (§7.8, §14.2): opening/updating the PR is autonomous; nothing lands on the
default branch without a human merge, enforced by branch protection — capability by
construction, not policy.
