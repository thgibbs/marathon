# 24. Risks and mitigations

## Risk: Slack UX becomes noisy

Mitigation:

* Threaded replies by default
* Rate-limited progress updates
* Ephemeral messages for private errors
* Clear final answer format

---

## Risk: Agents leak data

Mitigation:

* Least privilege (reads as well as writes — §12.2)
* Permission filters
* Redaction
* No secrets in prompts
* Gateway enforcement outside the model (deterministic safety perimeter — §7.8)
* Audience-routed egress → Proposed Effects (§7.9)
* Audit logs

---

## Risk: Long-running tasks are unreliable

Mitigation:

* Durable task state
* Checkpoints
* Worker leases
* Retries
* Dead-letter queue
* Replay tools

---

## Risk: Costs surprise admins

Mitigation:

* Budgets
* Cost estimates
* Model routing
* Per-task hard limits
* Cost dashboard

---

## Risk: Open-source setup is too hard

Mitigation:

* Docker Compose quickstart
* One-command demo
* Example Slack app config
* Built-in sample agent
* Minimal required services

---

## Risk: Agents are hard to debug

Mitigation:

* Task timeline
* Model/tool traces
* Replay support
* Eval cases
* Prompt versioning
