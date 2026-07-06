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
  +--> waiting_for_input ----+--> running    (input arrives — §11.6)
  |                          +--> expired    (wait lapses — terminal)
  |
  +--> waiting_for_approval -+--> running    (proposal resolved — §7.9, §11.6)
  |                          +--> expired    (approval expiry — terminal)
  |
  +--> retrying --> running
  |
  +--> completed
  |
  +--> failed
  |
  +--> cancelled
```

**`expired` is the clear terminal state** for a lapsed wait or a task that outlives its
overall deadline: it carries an explanation and is inspectable like any failure (§11.5,
§11.6). (`blocked` is retired from the state list — `retrying` and the waiting states cover
its cases.)

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

### BUILD-stage checkpoints (code work — K4, §29)

The generic example above is not enough for the kernel's BUILD stage, where a crash lands
mid-code-writing. The contract:

* **Checkpoint unit = one harness turn.** After each completed turn, persist: the session
  JSONL, the **workspace diff vs `base_sha`**, and the turn index. Turns are atomic.
  What a "turn" is depends on the harness: for **Pi** it is one prompt→response cycle; for
  **Claude Code** it is one `claude -p` invocation, **bounded with `--max-turns`** so the
  checkpoint cadence is a configuration knob, not the model's mood — an unbounded
  invocation would be one giant uncheckpointable turn (`claude-code-impl.md` §2).
* **Crash mid-turn → replay the turn, never splice it.** Partial tool results from an
  interrupted turn are untrustworthy; resume discards the incomplete turn and replays from
  the last completed checkpoint. Tool calls inside the replayed turn re-execute — safe
  because governed effects are idempotent (§11.3, §29.4) and the workspace is restored to
  turn-start state. Under Claude Code, "discard" is mechanical: the checkpointed session
  snapshot is restored **over** whatever partial JSONL the crashed invocation left, then
  the invocation reruns via `--resume`.
* **Containers are never recovered.** Resume always re-provisions a fresh sandbox and
  re-materializes the workspace (clone at `base_sha` + apply the checkpointed diff). A shell
  command in flight at crash time is simply gone; it reruns with its turn.
* **Test runs rerun, never resume.** A verification run interrupted mid-flight counts for
  nothing; only completed runs record results (§29.3).
* **The handoff is convergent.** A crash between push and record heals on re-submit:
  `github.submit_code_changes` is create-or-update, idempotent on `(task_id, tree_hash)`
  (§29.4).

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

Transient failures retry **automatically** (with backoff) without asking the user. High-risk effects are never silently retried — an approved proposal executes **at most once** (idempotency key, §7.9); if an effect's outcome is uncertain, the agent re-confirms with a human rather than retrying.

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
* On expiry, move to **`expired`** — the clear terminal state (§11.1) — with an explanation.

**Mechanism: async proposals + between-turn waits (no mid-turn suspend).** Neither harness
has a native "suspend a turn for days" — and neither needs one. `propose_effect` is an ordinary tool
call that **returns immediately** with an `effect_id` and a monitor handle (§7.9); the
proposal is worked on a durable queue. The agent finishes its turn normally — it can poll
`get_effect_status`, do other work, or report the pending proposal. If the task cannot
proceed without the outcome, the **turn ends** and the *task* enters `waiting_for_approval`:
a pure orchestration-layer wait (session JSONL persisted; no worker or process held — the M5
engine). On resolution, the non-model **executor performs the exact approved artifact**
(§7.9 — the model never re-executes it), and a worker **resumes the session between turns**,
appending the outcome as the next turn's input — the resume path both harnesses support
natively (re-opening a Pi session; Claude Code `--resume`). This
retires the mid-call suspend/fork question entirely. `waiting_for_input` (clarifying
questions) uses the same shape: ask, end the turn, resume with the answer.
