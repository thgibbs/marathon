# 19. MVP scope

## 19.1 MVP product promise

The MVP should prove:

> A team can self-host Marathon, install it in Slack, create a named agent, invoke it from Slack, let it use GitHub safely, and inspect the durable task afterward.

---

## 19.2 MVP functional requirements

The MVP ships **two surfaces — Slack and GitHub-backed markdown documents** — on the shared surface seam (§7.16), so further surfaces can be added without reworking the core.

P0 requirements:

1. Slack app installation (single Marathon bot).
2. Single Slack workspace support (a Slack workspace = one surface within a tenant).
3. Invoke from Slack via `@marathon <agent>`, with default-agent selection when none is named.
4. GitHub document surface: tag an agent in a PR/file comment, reply in-thread, and open PRs for document changes.
5. Agent registry.
6. One or more configurable agents.
7. Durable, idempotent task creation.
8. Async worker execution running the Pi harness.
9. Slack thread response and in-document (PR/comment) response.
10. Progress updates.
11. GitHub connector (read + comment + open PR).
12. Approval required only for destructive actions.
13. Feedback via Slack 👍/👎 (with optional text).
14. Admin/inspectability view for task history and traces.
15. Basic model provider config (Claude, ChatGPT, OpenRouter).
16. Cost tracking per task.
17. Docker Compose local deployment.

---

## 19.3 MVP non-functional requirements

P0 requirements:

1. Surface events acknowledged quickly.
2. Duplicate surface events deduplicated (Slack retries, GitHub webhooks).
3. Tasks persisted in Postgres.
4. Workers can restart without losing terminal task state.
5. Tool calls logged.
6. Model calls logged.
7. Secrets not stored in plaintext.
8. Tenant isolation in schema.
9. Basic audit log.
10. Basic retry policy.
11. Clear failure messages.

---

## 19.4 MVP cuts

Do not include in MVP:

* Multi-tenant enterprise management
* Full vector knowledge base
* Advanced model routing
* Complex eval UI
* Marketplace
* Fine-tuning
* SSO
* Dozens of connectors
* Full per-user impersonation
* Mobile UI
* Scheduled tasks
* User-initiated cancellation
* External agent / connector / SDK builder experience (internal-only initially)
* Per-agent `@mention` Slack identities (single `@marathon` bot initially)
* Document providers beyond GitHub markdown (Google Docs, Notion — on request)
