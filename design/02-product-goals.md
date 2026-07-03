# 2. Product goals

## Primary goals

### 1. Surface-native agent invocation

Users should be able to interact with agents where work already happens — starting with Slack and markdown documents in GitHub.

The UX should feel like asking a teammate. Marathon is a single bot; you address an agent by name after `@marathon`, and if you omit the name Marathon picks a sensible default agent for the task:

```text
@marathon bruce summarize this thread
@marathon ada review this PR
@marathon query last week's onboarding funnel   # no agent named → default
```

or by tagging an agent into a markdown doc or pull request on GitHub:

```text
@marathon ada is the risk analysis in this design doc complete?
@marathon quill draft release notes from this milestone
```

The platform should support threaded conversations, in-document comment threads, context loading, progress updates, clarification questions, and final responses — rendered natively on whichever surface the agent was invoked from.

---

### 2. Documents as a first-class surface

Marathon should treat documents as a peer to chat, in two modes:

* **Producing documents.** Agents create and update markdown documents (postmortems, release notes, PRDs, design docs, research summaries) by opening pull requests — a reversible action with a native review surface, taken autonomously; a human reviews and merges (the merge *is* the approval — §7.8).
* **Being tagged into documents.** Users can summon an agent on a document — via an `@mention` in a comment or review — anchored to a specific file or region. The agent replies in context (a comment reply by default; changes are proposed as a pull request for a human to merge).

The first document surface is **GitHub-backed markdown**: markdown files in a repository, with pull-request, issue, and review comments for tagging and discussion. It reuses the GitHub connector, is the easiest target for an agent, and gives versioning, anchored comments, and `@mention` webhooks for free. Other document providers (e.g. Google Docs, Notion) can be added later on request, behind the same surface interface.

Documents still bring harder problems than chat — access control and concurrent edits — which the design accounts for (see §7, §10, §12).

---

### 3. Durable long-running tasks

AI agent work is often slow and failure-prone. Marathon should treat every invocation as a durable task.

A task should survive:

* Worker crashes
* Model API failures
* Tool API failures
* Rate limits
* Deployments
* Network interruptions
* Human approval delays
* Slack retries

The user should not lose work because a process died halfway through a multi-step investigation. Task execution should be **idempotent**, so retries and duplicate events never double-apply effects (see §11.3).

---

### 4. Safe access to internal systems

Agents should be able to use internal tools, but only under controlled conditions.

Examples:

* GitHub
* Jira
* Linear
* Slack
* Google Drive
* Notion
* Datadog
* Grafana
* Snowflake
* Postgres
* Internal APIs
* CI/CD systems

Tool access must be explicit, permissioned, logged, and reviewable.

---

### 5. Model flexibility and cost control

Marathon should support multiple model providers and route different parts of a task to different models.

Examples:

* Cheap model for intent classification
* Mid-tier model for summarization
* Expensive reasoning model for planning
* Embedding model for retrieval

The initial providers are **Claude (Anthropic), ChatGPT (OpenAI), and OpenRouter**. Local/self-hosted models are not supported initially. The **current platform default is OpenAI (`gpt-4o-mini`)**; Claude and OpenRouter remain configurable per tenant/agent. Admins should be able to set budgets, provider preferences, fallback policies, and per-agent model rules.

---

### 6. Feedback-driven improvement

Users should be able to give feedback on agent outputs.

Feedback should become operational data:

* Which agents are useful?
* Which prompts fail?
* Which tools cause errors?
* Which model choices are too expensive?
* Which tasks should become evaluation cases?

Marathon should not claim that feedback magically trains the model. Instead, feedback should be **incorporated into agent memory and future context** (so an agent stops repeating a corrected mistake), and should be useful for prompt iteration, evaluation, and regression testing.

---

### 7. Open-source self-hostability

Marathon should be easy to run locally, self-host in a company environment, and extend.

The default developer experience should be:

```text
git clone
docker compose up
install Slack app
define first agent (a YAML file — §6.2)
invoke from Slack
```

A platform like this succeeds only if teams can trust it with internal systems and understand how it works.
