# 3. Non-goals

Marathon should avoid becoming too broad too early.

## Explicit non-goals for the initial product

### 1. General-purpose consumer chatbot

Marathon is for work agents operating on a team's existing surfaces — Slack and documents (GitHub-backed markdown) initially — not a general-purpose ChatGPT clone.

---

### 2. Autonomous unrestricted agents

Agents should not freely perform arbitrary *destructive* actions across internal systems — but they should be autonomous for the common, non-destructive case. The platform should favor:

* Scoped permissions
* Human approval for **destructive** actions only (most actions run autonomously)
* Audit logs
* Explicit tool policies
* Safe defaults that still keep agents useful (safety should not make them useless)

---

### 3. Automatic model training from feedback

Feedback should be stored and used for evaluation, prompt improvement, and future fine-tuning pipelines, but the MVP should not promise automatic learning.

---

### 4. Full internal knowledge platform

**Enterprise search is a non-goal.** Marathon should not try to replace Glean, Notion, Google Drive, Confluence, or enterprise search. Instead, agents reach existing knowledge bases through **MCP servers and tools**.

Note the distinction: *producing and collaborating in* documents is in scope (the document surface, §7.17); *being the organization's knowledge base / search index* is not.

---

### 5. Full workflow automation suite

Marathon may eventually support scheduled jobs, recurring workflows, and event-driven agents, but the initial product should focus on tasks triggered from a surface — a Slack mention or a document (PR/file) comment.
