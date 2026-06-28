# 11. Task execution model

## 11.1 Task state machine

```text
created
  |
  v
queued
  |
  v
running
  |
  +--> waiting_for_input
  |       |
  |       v
  |     running
  |
  +--> waiting_for_approval
  |       |
  |       v
  |     running
  |
  +--> retrying
  |       |
  |       v
  |     running
  |
  +--> completed
  |
  +--> failed
  |
  +--> cancelled
```

---

## 11.2 Checkpointing

Each task should persist enough state to resume safely.

Checkpoint examples:

```json
{
  "phase": "checking_recent_deploys",
  "completed_steps": [
    "loaded_slack_thread",
    "searched_github_prs"
  ],
  "current_findings": [
    "checkout errors increased after 9:49 AM",
    "deploy happened at 9:42 AM"
  ],
  "pending_tool_call": null
}
```

---

## 11.3 Idempotency

Every external action should have an idempotency key. Keys are a property of the *action* and the *surface*, not Slack-specific.

Examples:

```text
task_id + tool_name + normalized_input_hash
task_id + approval_id + action_name
surface_type + external_event_id              # e.g. slack_team_id + slack_event_id
repo + path + base_sha + action_name          # for markdown document edits on GitHub
```

This prevents duplicate surface events or retries — Slack retries, repeated GitHub webhooks — from creating duplicate issues, comments, messages, or document edits. For document writes, `base_sha` also guards against editing a file that changed underneath the task (re-validate or rebase before writing).

---

## 11.4 Retry policy

Default retry behavior:

| Error type              | Retry?                 |
| ----------------------- | ---------------------- |
| Network timeout         | Yes                    |
| Model rate limit        | Yes, with backoff      |
| Tool rate limit         | Yes, with backoff      |
| Invalid tool input      | No                     |
| Permission denied       | No                     |
| Approval rejected       | No                     |
| Worker crash            | Resume from checkpoint |
| Unknown transient error | Limited retry          |

Transient failures retry **automatically** (with backoff) without asking the user. Destructive actions are never silently retried — if a destructive step's outcome is uncertain, the agent re-confirms with a human rather than retrying.

---

## 11.5 Dead-letter queue

Tasks that repeatedly fail should move to a dead-letter state.

Admin UI should show:

* Task ID
* Agent
* User
* Failing step
* Error
* Retry count
* Last checkpoint
* Suggested action
* Replay option

---

## 11.6 Durable human waits

`waiting_for_approval` and `waiting_for_input` are first-class durable states, not in-memory pauses. A human wait may last **days** — especially in a document review cycle where an agent opens a pull request and waits for a reviewer.

Requirements:

* Persist the full wait state and resume cleanly when the human responds.
* Set an expiration and re-notify before expiry.
* Hold no worker or open connection for the duration of the wait.
* On expiry, move to a clear terminal state with explanation.

**Mechanism on Pi (block-persist-resume).** Pi has no native "suspend a turn for days,"
but its sessions are resumable. So a destructive action is handled by: the `tool_call` hook
**blocks** the call (no execution, no process held) → Marathon persists the Pi **session
JSONL**, sets `waiting_for_approval`, posts the in-place prompt, and tears down the worker →
on approval, a worker **re-opens the session and re-enters** so the approved action runs. The
re-entry mechanism (re-prompt-to-continue vs. fork-before-the-blocked-call) is a Pi
integration detail to settle in the early spike; see `pi-details.md` §6.3.
