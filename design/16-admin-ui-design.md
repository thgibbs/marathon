# 16. Admin UI design

## 16.1 Main navigation

Recommended sections:

```text
Agents
Tasks
Surfaces
Connectors
Approvals
Feedback
Evals
Costs
Audit Log
Settings
```

---

## 16.2 Agent detail page

Should show:

* Agent name
* Description
* Owner
* Status
* Current version
* Instructions
* Model policy
* Tool grants
* Channels/users allowed
* Memory settings
* Approval settings
* Recent tasks
* Feedback summary
* Cost summary
* Error summary
* Publish/rollback controls

---

## 16.3 Task detail page

Should show:

* Task summary
* Source link (surface-native: Slack thread, document, …)
* User
* Agent
* Status
* Timeline
* Model calls
* Tool calls
* Approvals
* Cost
* Logs
* Errors
* Feedback
* Replay button
* Save as eval button

Timeline example:

```text
10:03:01 Task created
10:03:02 Slack thread loaded
10:03:04 Intent classified
10:03:10 GitHub searched
10:03:18 PR #4812 read
10:03:29 Datadog queried
10:03:42 Final response posted
10:04:11 User gave thumbs up
```

---

## 16.4 Connector page

Should show:

* Connector status
* Credential mode
* Available tools
* Granted agents
* Recent tool calls
* Error rate
* Rate limit status
* Credential rotation
* Disable connector

---

## 16.5 Cost dashboard

Views:

* Total cost
* Cost by tenant
* Cost by agent
* Cost by model
* Cost by task type
* Cost by user
* Cost over time
* Most expensive tasks
* Budget alerts
