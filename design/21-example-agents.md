# 21. Example agents

## 21.0 Forge: the flagship kernel agent (ships first)

The kernel runs **one agent** (§0.4) that spans the whole loop — it drafts the design doc
*and* writes the code. Bruce/Ada/Grace/Linus/Quill below are **direction**, not kernel.

Purpose:

> Run the §0.1 loop end-to-end on the deployment's one configured repo: turn a Slack ask
> into a design-doc PR, iterate on review, and implement the merged plan as a green-tested
> code PR (§29).

Definition (the actual YAML shape, §6.2):

```yaml
name: forge
display_name: Forge
description: Drafts design docs from Slack asks and implements merged plans as code PRs.
harness: pi                       # deployment default; claude-code once K7 lands

repo: your-org/your-repo          # the ONE configured target repo (§0.4)

instructions: |
  You run one loop: ask → design doc → review → merged plan → code → PR.
  For any non-trivial ask, draft a design document first (a markdown PR) —
  never jump straight to code. Answer trivial questions directly in the thread.
  Ask clarifying questions early, in the thread, before drafting.
  Implement exactly the merged plan. If the plan turns out to be wrong, say so
  in the thread and propose a doc revision — never silently diverge from it.
  Verify before handing off: run the repo's verify commands and iterate until
  green. If you cannot get green within budget, submit a draft PR and report
  the failure honestly — never claim tests pass when they don't.
  Keep PRs small and focused; put open questions in the PR body.

tools:
  - slack thread context          # via the context builder (§7.18)
  - document.*                    # draft / revise / comment / reply (§14.6)
  - github reads                  # issues, PRs, code search (§14.2)
  - github.submit_code_changes    # the BUILD→DELIVER handoff (§29)
  - bash / read / write / edit    # sandboxed (§12.6)
  - get_task_status

models:
  default: openai:gpt-4o-mini     # deployment default (§7.19)
```

Grants and rules — enforced **by construction** (§7.8), the prompt just explains them:

* One repo; the `marathon/` branch namespace; **no default-branch writes** (branch
  protection); `.github/workflows/**` and other protected paths refused; diff-size caps
  (§29.4).
* Egress: replies to the originating thread and writes to the configured repo (the OQ-4
  calibration); **no external tools registered** — external egress cannot happen.
* Budget: a hard per-task cost cap; an iteration cap on the verify loop.

Failure behavior (the honest paths):

* Red verify at the cap → **draft PR** + `marathon:unverified` + a failure summary (§29.3).
* Blocked on ambiguity → ask in the thread and end the turn (§11.6); never guess silently.
* Merge conflict on the code PR → report it; a human (or an explicit revision comment)
  resolves it (§29.6).
* Gateway denial (typed errors — §29.4) → adjust and retry in-session; if impossible, report
  the denial verbatim.

---

## 21.1 Bruce: Engineering investigation agent

Purpose:

> Investigates production issues using Slack context, GitHub, logs, and runbooks.

Tools:

* Slack thread reader
* GitHub search
* GitHub PR reader
* Datadog logs
* Runbook search
* GitHub issue creation (reversible, repo audience — autonomous, §7.8)

Good tasks:

```text
@marathon bruce why did checkout errors spike?
@marathon bruce summarize this incident thread
@marathon bruce find the PR that likely caused this regression
```

---

## 21.2 Ada: Code review agent

Purpose:

> Reviews PRs for correctness, readability, tests, and risk.

Tools:

* GitHub PR reader
* Repo search
* CI status
* Comment on PR (reversible, repo audience — autonomous, §7.8)

Good tasks:

```text
@marathon ada review this PR
@marathon ada check whether this change needs a migration
@marathon ada summarize the risk in this diff
```

---

## 21.3 Grace: Data analyst agent

Purpose:

> Answers business/data questions using approved read-only datasets.

Tools:

* Schema browser
* Read-only SQL query
* Chart generator
* Dashboard search

Good tasks:

```text
@marathon grace what happened to activation last week?
@marathon grace compare paid conversion by channel
@marathon grace summarize this dashboard
```

---

## 21.4 Linus: Release helper agent

Purpose:

> Helps prepare, check, and communicate releases.

Tools:

* GitHub releases
* CI status
* Jira/Linear
* Slack posting (autonomous in the originating thread; posts outside it route to a proposal — §7.8). Deployments are high-risk: proposed via `propose_effect`, never direct (§7.9)

Good tasks:

```text
@marathon linus prepare release notes for today
@marathon linus check whether the release is blocked
@marathon linus draft the launch update
```

---

## 21.5 Quill: Document agent

Purpose:

> Drafts and maintains markdown documents — PRDs, postmortems, design docs, release notes — in GitHub, and can be tagged into a pull request or file to revise a specific section.

Tools:

* Markdown file reader
* Document create/update via pull request (native review — a human merges; §7.8)
* PR / issue / review comment + reply
* GitHub and Slack readers for source material

Good tasks:

```text
@marathon quill draft a postmortem from this incident thread
@marathon quill (in a PR comment) tighten the open questions in this section
@marathon quill turn this design doc into release notes
```

This agent exercises the document surface in both modes: producing documents and being tagged into them.
