# 4. Target users

## 4.1 Slack end user

This is the person invoking agents.

Examples:

* Engineer
* Product manager
* Support lead
* Data analyst
* Engineering manager
* Designer
* Founder
* Operations teammate

They want to ask for help without learning a new interface.

Their concerns:

* “Which agent should I use?”
* “Did the agent understand me?”
* “Is it still working?”
* “Can I trust the answer?”
* “What data did it use?”
* “Can I correct it?”

---

## 4.2 Tenant admin

This person installs and configures Marathon for their organization (tenant).

They care about:

* Slack app installation
* Agent permissions
* Connector setup
* Model provider keys
* Security policies
* Audit logs
* Cost limits
* Data retention
* User access control

---

## 4.3 Agent developer

This person builds agents and connectors.

> Initial scope: agents and connectors are built by the Marathon team (internal). There is no external agent-developer experience yet; this persona is documented for direction, not built first.

They care about:

* Local development
* Agent SDK
* Tool SDK
* Testing
* Versioning
* Logs
* Traces
* Replays
* Deployment
* Evaluation

---

## 4.4 Agent owner

This person is responsible for a specific agent’s quality.

> Initial scope: internal to the Marathon team. Documented for direction, not built first.

Examples:

* DevTools team owns `@release-helper`
* Data team owns `@metrics`
* Support team owns `@triage`
* Platform team owns `@incident`

They care about:

* Agent performance
* Feedback
* Cost
* Failures
* Prompt versions
* Connector reliability
* User satisfaction
