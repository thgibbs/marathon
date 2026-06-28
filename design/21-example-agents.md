# 21. Example agents

## 21.1 Bruce: Engineering investigation agent

Purpose:

> Investigates production issues using Slack context, GitHub, logs, and runbooks.

Tools:

* Slack thread reader
* GitHub search
* GitHub PR reader
* Datadog logs
* Runbook search
* GitHub issue creation (non-destructive — no approval)

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
* Comment on PR (non-destructive — no approval)

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
* Slack posting (non-destructive — no approval; deployments do require approval)

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
* Document create/update via pull request (non-destructive; a human merges)
* PR / issue / review comment + reply
* GitHub and Slack readers for source material

Good tasks:

```text
@marathon quill draft a postmortem from this incident thread
@marathon quill (in a PR comment) tighten the open questions in this section
@marathon quill turn this design doc into release notes
```

This agent exercises the document surface in both modes: producing documents and being tagged into them.
