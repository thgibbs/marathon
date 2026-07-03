# 8. Non-functional requirements

## 8.1 Reliability

Requirements:

* Surface events must be acknowledged within the transport's window — e.g. Slack HTTP events within ~3s; Socket Mode (the as-built Slack transport, §9.2) acks each envelope promptly.
* Task execution must be asynchronous.
* Tasks must survive worker crashes.
* Workers must use leases or heartbeats.
* Steps must be checkpointed.
* External calls must have timeouts.
* Retriable failures must retry.
* Non-retriable failures must fail clearly.
* Failed tasks must be inspectable.
* Duplicate surface events (Slack retries, repeated GitHub webhooks) must not create duplicate work.

Reliability target examples:

| Metric                       | Target                             |
| ---------------------------- | ---------------------------------- |
| Surface event acknowledgement | Under each surface's timeout window |
| Task creation durability     | 99.9%+                             |
| Worker crash recovery        | Task resumes or fails cleanly      |
| Duplicate event handling     | Idempotent                         |
| Tool timeout handling        | Explicit failure state             |

---

## 8.2 Security

Security requirements:

* Tenant isolation
* Least privilege tool access
* Encrypted secrets
* No secrets in prompts
* High-risk effects via propose → review → execute (§7.9)
* Audit logs for all tool calls
* Per-user authorization where possible
* Connector credential scoping
* Prompt injection defenses
* Data redaction
* Retention controls
* Admin role separation

Threats to address:

| Threat                                             | Mitigation                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Prompt injection from Slack text                   | Treat Slack content as untrusted; enforce tool policies outside model |
| Agent leaks secret                                 | Never expose raw secrets to model                                     |
| User tricks agent into accessing unauthorized repo | Check user + agent permissions before tool call                       |
| Tool output contains malicious instruction         | Mark tool output as data, not instruction                             |
| Agent attempts a high-risk effect                  | Never a direct tool — propose → review → execute (§7.9)               |
| Injected agent exfiltrates (read private → write lower-trust) | Least-privilege reads, redaction, egress policy (§7.8): external egress and beyond-requestor-access disclosure → proposals |
| Cross-tenant data leak                             | Tenant-scoped storage and auth checks                              |
| Excessive model cost                               | Budgets, routing, alerts, hard limits                                 |

---

## 8.3 Scalability

The architecture should scale by separating:

* Slack event ingestion
* Task orchestration
* Worker execution
* Model calls
* Tool calls
* Retrieval
* Admin UI
* Observability

Scaling requirements:

* Multiple surfaces (Slack workspaces, document accounts) per tenant
* Many agents per tenant
* Many concurrent tasks
* Horizontal worker scaling
* Queue backpressure
* Connector rate limit management
* Model provider rate limit management
* Large Slack threads
* Large tool outputs
* Large retrieved documents

---

## 8.4 Latency

There are two latency categories.

### Interactive latency

This is the time from Slack mention to acknowledgement.

Goal:

> User should quickly see that the agent has started.

### Completion latency

This depends on task complexity.

For long-running tasks, Marathon should provide:

* Initial acknowledgement
* Progress updates
* Waiting states
* Partial findings
* Final response
* Failure explanation

---

## 8.5 Observability

Marathon should support three levels of observability.

### System observability

* API latency
* Queue depth
* Worker health
* Database health
* Error rates
* Rate limits

### Agent observability

* Task traces
* Prompt versions
* Model calls
* Tool calls
* Intermediate reasoning summaries
* Cost
* Feedback

### User observability

* Task status
* What the agent is doing
* What data it used
* What actions it took
* What needs approval

---

## 8.6 Portability

Marathon should support:

* Local Docker Compose
* Single VM deployment
* Kubernetes deployment
* Cloud-neutral storage
* OpenTelemetry
* Pluggable model providers
* Pluggable secret stores
* Pluggable vector stores

Avoid requiring one specific cloud provider.

---

## 8.7 Extensibility

Extension points:

* Model providers
* Tool connectors
* Agent runtimes
* Memory backends
* Queue backends
* Auth providers
* Evaluation backends
* Slack-compatible chat platforms later

Design rule:

> Core abstractions should be stable even if backends change.

---

## 8.8 Compliance and privacy

Requirements:

* Configurable data retention
* Data deletion
* Tenant export
* PII redaction hooks
* Secret redaction hooks
* Provider data controls
* Audit logs
* Access logs
* Admin consent for model providers
* Option to disable external model providers
