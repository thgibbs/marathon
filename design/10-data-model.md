# 10. Data model

## 10.1 Tenant

Represents the top-level isolation boundary (an organization/customer). A Slack workspace is a *property of the Slack surface* within a tenant, not the tenant itself; a tenant may have zero or many connected Slack workspaces and document accounts.

Fields:

```text
id
name
created_at
updated_at
settings
retention_policy
default_model_policy
budget_policy
```

Slack-specific identifiers (e.g. `slack_team_id`) live with the Slack surface configuration, not on the tenant.

---

## 10.2 User and UserIdentity

A **User** is a person known to Marathon within a tenant. Because a person may appear on multiple surfaces (Slack, Google, email), external identities are modeled separately in **UserIdentity**, rather than keying the user on `slack_user_id`.

User fields:

```text
id
tenant_id
display_name
email
role
created_at
updated_at
```

UserIdentity fields (a surface identity is unique **within a tenant** —
`unique(tenant_id, surface_type, external_id)` — since the same external id can
recur across tenants/workspaces):

```text
id
user_id
tenant_id
surface_type        # slack | github | web | email
external_id         # e.g. slack_user_id, GitHub login — proven, never typed (§7.20)
verified_at
verification_method # oauth | idp | admin_asserted (§7.20; tenant policy sets the tier on-behalf-of requires)
status              # active | stale | revoked — a failed token refresh marks stale (→ deny)
credential_ref      # optional user-to-server token: access checks *as the user* (§7.20, §12.3)
created_at
updated_at
```

Roles:

```text
admin
agent_owner
developer
user
viewer
```

---

## 10.3 Agent

Represents the logical agent.

Fields:

```text
id
tenant_id
name
display_name
description
owner_user_id
status
created_at
updated_at
```

---

## 10.4 AgentVersion

Represents a versioned agent configuration.

Fields:

```text
id
agent_id
version_number
status
instructions
model_policy
tool_policy
memory_policy
approval_policy
created_by
created_at
published_at
```

---

## 10.5 ConnectorInstallation

Represents an installed connector.

Fields:

```text
id
tenant_id
connector_type
display_name
status
auth_mode
credential_ref
config
created_at
updated_at
```

Connector types:

```text
github
slack
postgres
datadog
google_drive
notion
jira
linear
custom_http
mcp
```

---

## 10.6 Tool

Represents a callable tool exposed by a connector.

Fields:

```text
id
connector_installation_id
name
description
input_schema
output_schema
risk_axes            # reversibility / trust-boundary / audience / cost (§7.8)
default_mode         # autonomous | native_review | proposed_effect | disabled (§7.8)
default_timeout_ms
default_retry_policy
created_at
updated_at
```

---

## 10.7 AgentToolGrant

Defines which agent can use which tool.

Fields:

```text
id
agent_version_id
tool_id
grant_scope
constraints
approval_policy
created_at
updated_at
```

Example constraints:

```json
{
  "allowed_repositories": ["acme/checkout", "acme/payments"],
  "allowed_channels": ["C123", "C456"],
  "readonly": true
}
```

A grant is **construction-time wiring**: it determines which tools get registered into the
agent's session (and their read-scoping constraints — least-privilege reads, §12.2), not a
runtime security boundary. Enforcement of *what a tool call may do* lives in credential scope,
resource-native permissions, and the egress policy (§7.8).

---

## 10.8 Task

Represents one user invocation.

Fields:

```text
id
tenant_id
agent_id
agent_version_id
invoking_user_id
source_type         # slack | github | web | api | email | schedule
source_ref          # opaque JSON locating the originating place (channel+thread_ts, doc_id+anchor, ...)
delivery_targets    # ordered list of {surface_type, ref} — same shape as source_ref; defaults to [the source]
status
input_text
summary
cost_usd
created_at
started_at
completed_at
failed_at
cancelled_at
```

`delivery_targets` is deliberately minimal: where progress/results are delivered, defaulting
to the source. Cross-surface delivery (roadmap M8 carry-over) extends the list without a
schema change.

---

## 10.9 TaskStep

Represents a durable step within a task.

Fields:

```text
id
task_id
step_type
status
input_ref
output_ref
error
retry_count
started_at
completed_at
checkpoint
```

Step types:

```text
load_context
classify_intent
plan
model_call
tool_call
approval_request
respond
summarize
finalize
```

---

## 10.10 ModelInvocation

Represents one model call.

Fields:

```text
id
task_id
task_step_id
provider
model
prompt_version
input_tokens
output_tokens
cost_usd
latency_ms
status
error
created_at
```

Store prompt/response content according to retention and privacy policy.

---

## 10.11 ToolInvocation

Represents one tool call.

Fields:

```text
id
task_id
task_step_id
tool_id
status
input_summary
output_summary
risk_axes
approval_id
latency_ms
error
created_at
```

---

## 10.12 ApprovalRequest

Represents human approval.

Fields:

```text
id
tenant_id
task_id
tool_invocation_id   # for gateway-gated calls
proposed_effect_id   # for high-risk effects (§10.17) — approval binds to the proposal's payload_hash
requested_by_agent_id
requested_from_user_id
status
action_summary
risk_axes
expires_at
created_at
resolved_at
resolved_by_user_id
```

Statuses:

```text
pending
approved
rejected
expired
cancelled
```

---

## 10.13 Feedback

Represents user feedback.

Fields:

```text
id
tenant_id
task_id
agent_id
agent_version_id
user_id
feedback_type
rating
comment
slack_reaction
created_at
```

---

## 10.14 EvaluationCase

Represents a reusable test case.

Fields:

```text
id
tenant_id
agent_id
source_task_id
name
input
expected_behavior
expected_tools
disallowed_tools
grading_method
created_at
updated_at
```

---

## 10.15 AuditEvent

Represents security-relevant events.

Fields:

```text
id
tenant_id
actor_user_id
actor_agent_id
event_type
target_type
target_id
summary
metadata
created_at
```

Audit event examples:

```text
agent.created
agent.version_published
connector.installed
credential.rotated
tool.granted
approval.approved
approval.rejected
tool.called
policy.denied
task.cancelled
```

---

## 10.16 DocumentArtifact

Tracks documents Marathon has produced or is watching (as an invocation surface).

Fields:

```text
id
tenant_id
surface_type        # github (markdown); other providers later
location            # for GitHub: repo + path (+ branch); opaque per provider
title
role                # produced | watched
owning_task_id
owning_agent_id
last_revision_seen  # git blob/commit SHA, for concurrent-edit detection (see §11.3)
created_at
updated_at
```

---

## 10.17 ProposedEffect

Represents a high-risk external effect proposed by the model and — if approved — performed by
the non-model **executor** (§7.9). The model never executes these directly.

Fields:

```text
id                   # effect_id
tenant_id
task_id
connector_id
effect_type          # slack_post | email_send | doc_delete | github_merge | internal_api_call | ... (typed per connector)
target               # destination / resource
payload              # the EXACT proposed content or mutation
payload_hash         # approval binds to this; a changed payload voids approval
proposal_version     # edits create a new version; approval applies to exactly one
provenance           # what the agent read to produce this (decision support + forensics)
risk_axes            # reversibility / trust-boundary / audience / cost
rollback_plan        # optional
reviewer_id
reviewer_authority   # checked against target resource, effect type, and blast radius
approval_expires_at
idempotency_key      # bounds execution to at most once
execution_state      # proposed | approved | rejected | expired | executing | executed | failed
created_at
resolved_at
executed_at
```

Invariants (§7.9, `policy.md` §11.4): the proposal is immutable once review starts; execution
revalidates tenant, credential, resource, destination, payload hash, and reviewer authority;
each approved effect executes at most once per `idempotency_key`; every transition is logged
as an audit event.

> Deliberately lightweight — expect this shape to evolve as connectors accrete. Only the
> fields the §7.9 invariants bind (payload hash, proposal version, idempotency key, expiry,
> execution state, reviewer) are load-bearing; the rest may change freely.

---

## 10.18 MemoryItem

Represents one generated memory (§7.12). The store holds only **generated** memory — external
documents are tool reads with their own ACLs, never ingested.

Fields:

```text
id
tenant_id
level                    # tenant | project | user | thread — the audience scope (agent is NOT a level)
project_id               # when level = project
user_id                  # when level = user
thread_id                # when level = thread
term                     # short | long (short-term carries expires_at)
kind                     # summary | correction | preference | message | fact | ...
agent_id                 # relevance metadata only — boosts ranking, never an access filter
text
embedding
provenance_task_id
provenance_sensitivity   # feeds narrowest-scope write enforcement + egress accounting (§7.8)
created_at
expires_at
```

Access rules (§7.12): recall requires the task's audience ⊆ the item's scope audience;
tenant-scoped writes require confirmation; `list`/`forget` per scope for inspection,
retention, and erasure (§12.5).

> Deliberately lightweight — expect this shape to evolve as external backends (Mem0, Zep) and
> fact-extraction/consolidation land behind the `MemoryStore` interface. The load-bearing
> fields are the audience scope (`level` + its id) and the provenance sensitivity.

---

## 10.19 CodeChange

The first-class record of one BUILD → DELIVER handoff (§29) — what makes the code path
inspectable, resumable, and debuggable. One row per implementation task; revisions (§29.6)
update it.

```text
id
tenant_id
task_id
repo
plan_ref             # { doc_path, merge_commit_sha } — the merged plan being implemented
base_sha             # pinned base (the plan's merge commit; the branch tip for revisions)
branch               # marathon/<task_id>-<slug>
tree_hash            # idempotency anchor for submit (§29.4)
pr_number
pr_url
state                # building | submitted_draft | submitted_ready | merged | closed
verification         # [{ command, exit_code, summary_ref }] (§29.3)
created_at
updated_at
```

Deliberately the **only** new entity for the code path: the workspace is ephemeral by design
(its lifecycle lives in audit events + per-turn checkpoints, §11.2); the plan is the merged
document (`DocumentArtifact` + `plan_ref`); branch, PR, and test results fold in here rather
than becoming entities of their own.
