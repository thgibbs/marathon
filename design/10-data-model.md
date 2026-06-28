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
external_id         # e.g. slack_user_id, GitHub login
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
risk_level
default_timeout_ms
default_retry_policy
requires_approval
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
delivery_targets    # where outputs are delivered (may differ from the source surface)
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
risk_level
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
tool_invocation_id
requested_by_agent_id
requested_from_user_id
status
action_summary
risk_level
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
