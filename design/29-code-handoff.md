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

Plan documents live on a dedicated **plans branch**, not the default branch (§29.1a —
decision 2026-07-04). The doc PR targets the plans branch; **merging it there is the
approval**, and the merge (M6 webhook, filtered on the plans base ref) spawns the
**implementation task**:

```text
plan_ref            = { repo, doc_path, merge_commit_sha }   # the plan, at its merged version
                                                             #   (a plans-branch commit)
base_sha            = <default-branch head at approval>      # the commit the work builds on
delivery_targets    = [ originating Slack thread, doc PR ]   # inherited via the task chain (K2)
idempotency_key     = (repo, doc_path, merge_commit_sha, "implement")
```

* `plan_ref` is **pinned to the plan's merge commit on the plans branch**: deterministic,
  auditable, content-addressable forever (git history is the record), and voided by revision —
  a revised-and-re-merged plan is a **new** version → a new task.
* `base_sha` is **pinned to the default branch's head, captured once at approval time** and
  carried on the task. It no longer coincides with the plan's merge commit (they live on
  different branches); each is recorded separately on the task and the `CodeChange` (§29.8).
* Because the plan is no longer in the tree at `base_sha`, the workspace **materializes the
  plan doc** at its `doc_path` during provisioning (§29.2) — the agent still reads it with its
  own file tools, no side-channel plan delivery, and the doc rides the diff into the code PR
  (§29.1a).
* One implementation task per merged plan version: a re-delivered webhook is a no-op.

## 29.1a The plans branch — main only carries shipped plans

**Decision (2026-07-04, supersedes merge-into-main).** Merging plan docs into the default
branch litters it with documents that may never be implemented or may not match the final
outcome. Instead:

* **Doc PRs target a long-lived plans branch** (default `marathon-plans`; configurable —
  `plans.branch`). Review UX, CODEOWNERS, and branch protection apply to that branch
  unchanged; the merge remains the same deliberate, sha-pinned, natively-attributable
  approval signal (§7.9). Marathon creates the branch at bootstrap when missing.
* **The plans branch is an approval boundary, so it must sit OUTSIDE the agent push
  namespace.** Agents push implementation branches under `marathon/*` (§29.5), and the
  brokered `git.exec` path relies on GitHub branch protection/rulesets for final
  enforcement — a plans branch *inside* that namespace (e.g. `marathon/plans`) would live in
  exactly the prefix rulesets leave open to the agent. Hence the default is `marathon-plans`
  (outside the prefix), wiring refuses a `plans.branch` under `marathon/*`, and the branch
  must be protected like the default branch: changes land only by merging a reviewed PR,
  never by direct push.
* **An implemented plan merges into main WITH its implementation.** The BUILD workspace
  materializes the approved plan doc at its `doc_path` (part of provisioning, so it is in the
  diff by construction); the code PR therefore carries **code + plan as one reviewable
  unit**, and the plan lands on the default branch only when the work does. If review on the
  code PR forces divergence from the approved plan, the agent amends the doc **on the code
  branch** — what reaches main is the **as-built** plan, not the as-hoped one.
* **An abandoned plan stays on the plans branch.** Never implemented, or its code PR closed
  unmerged — nothing reaches main. The plans branch is the append-only ledger of everything
  considered; the default branch keeps the invariant: **a plan doc on main means the plan
  shipped**.

Alternatives considered and rejected: merge-to-main + cleanup (transient litter, churn
commits); approve-without-merge via PR review (weaker ritual, review-dismissal state
machinery, no canonical merged plan); a separate plans repo (cross-repo credentials, fights
the K6 thirty-minute setup); ADR-style append-only log on main (exactly the litter being
declined). Recorded in `open-questions.md` (OQ-9).

## 29.2 Workspace lifecycle

1. **Provision** the sandbox (pinned toolchain image digest — K1 prerequisite).
2. **Materialize** the workspace **host-side**: clone the repo at `base_sha` (detached),
   **write the approved plan doc at its `doc_path`** (fetched at `plan_ref.merge_commit_sha`
   from the plans branch, §29.1a — so the plan is in the working tree and thus in the diff),
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
* Every command run, exit code, and a size-capped output summary is recorded on the task and
  echoed in the PR body.

## 29.4 The handoff tool — `github.submit_code_changes`

One governed tool ends the BUILD stage:

```text
github.submit_code_changes(
  title,           # PR title
  summary,         # what was done and why (PR body)
  plan_ref,        # echoed { repo, doc_path, merge_commit_sha } — gateway validates it matches the task
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
* **PR body template:** summary → **plan link** (`doc_path` @ `merge_commit_sha`) →
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
