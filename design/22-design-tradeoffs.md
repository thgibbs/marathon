# 22. Important design tradeoffs

## 22.1 One Slack bot vs many agent identities

### One bot

Better for MVP.

```text
@marathon bruce investigate this
```

### Many identities

Better UX.

```text
@bruce investigate this
```

Recommendation:

> Design the data model for many agent aliases, but ship one bot first.

---

## 22.2 Service account vs user impersonation

### Service account

Pros:

* Easier setup
* Easier tool execution
* Good for read-only workflows

Cons:

* Weaker per-user authorization
* More risk if over-permissioned

### User impersonation

Pros:

* Better security
* Respects existing permissions
* Easier compliance story

Cons:

* More OAuth complexity
* Harder connector implementation

Recommendation:

> Start with scoped service accounts. Add user impersonation for sensitive connectors. The first document surface (GitHub markdown) uses repository permissions and needs no impersonation; add it only if a finer-grained provider (e.g. Google Docs) is later requested.

---

## 22.3 Simple queue vs workflow engine

### Simple queue

Pros:

* Easier install
* Easier MVP
* Fewer dependencies

Cons:

* More custom retry/checkpoint logic

### Workflow engine

Pros:

* Better durability
* Better long-running task semantics
* Better retries

Cons:

* More complex deployment

Recommendation:

> Use a simple **Postgres-backed queue** first, but keep task interfaces workflow-engine-compatible.

---

## 22.4 Built-in connectors vs MCP

### Built-in connectors

Pros:

* Better UX
* Better security
* Better docs
* Better permission model

Cons:

* More work to build

### MCP

Pros:

* Leverages existing ecosystem
* Fast extensibility
* Good for internal tools

Cons:

* Quality varies
* Security wrapper still needed

Recommendation:

> Support multiple tool sources behind the **one tool layer in the Pi harness** (which enforces permissioning): built-in (non-MCP) connectors for common systems, **command-line tools** as a primary choice (some supplied by Pi), and MCP so customers can bring their own tools.

---

## 22.5 Full trace logging vs privacy

### Full trace logging

Pros:

* Easier debugging
* Better eval creation
* Better quality improvement

Cons:

* Privacy risk
* Sensitive data exposure

### Metadata-only logging

Pros:

* Safer
* Better for sensitive environments

Cons:

* Harder debugging

Recommendation:

> Start with **full trace logging on by default**, configurable (retention and on/off) by tenant and data class.
