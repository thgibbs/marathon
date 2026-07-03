# 3. Non-goals

Marathon should avoid becoming too broad too early.

## Explicit non-goals for the initial product

### 1. General-purpose consumer chatbot

Marathon is for work agents operating on a team's existing surfaces — Slack and documents (GitHub-backed markdown) initially — not a general-purpose ChatGPT clone.

---

### 2. Autonomous unrestricted agents

Agents should not freely perform arbitrary *high-risk* actions across internal systems — but they should be autonomous for the common, low-risk case. The platform should favor:

* Scoped, least-privilege credentials (reads as well as writes — §12.2)
* Risk-routed effects (§7.8): autonomous when reversible and audience-bounded; native review (a PR a human merges) where the surface supports it; **Proposed Effects** (§7.9) for high-risk effects — irreversible, cross-trust-boundary, public/external, or costly
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

(One deliberate exception already exists: **watched documents** — a push touching a tracked file spawns a review task (roadmap M7). That is a narrow, document-surface-scoped trigger, not a general event system.)
