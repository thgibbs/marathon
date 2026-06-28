# 6. Core user journeys

## 6.1 Install Marathon into Slack

Admin flow:

1. Admin deploys Marathon.
2. Admin opens setup UI.
3. Admin connects Slack workspace.
4. Admin grants Slack app permissions.
5. Admin configures model provider.
6. Admin creates first agent.
7. Admin invites users or enables selected channels.
8. User invokes the first agent.

Success criterion:

> A new tenant can install Marathon, configure one model provider, create one agent, and invoke it from Slack.

---

## 6.2 Create an agent

> Initial scope: internal. Agents are created by the Marathon team, not by customers; this flow is documented for direction.

Agent owner flow:

1. Open Marathon admin UI.
2. Click “Create Agent.”
3. Choose name: `bruce`.
4. Add description: “Engineering investigation agent.”
5. Configure instructions.
6. Select allowed channels.
7. Select models.
8. Select tools.
9. Configure approval requirements.
10. Save draft.
11. Test in sandbox.
12. Publish agent version.

Example agent configuration:

```yaml
name: bruce
display_name: Bruce
description: Investigates engineering issues using GitHub, logs, and runbooks.

instructions: |
  You are Bruce, an engineering investigation agent.
  Be concise. State uncertainty clearly.
  Use tools before making claims about recent production state.
  Act autonomously for non-destructive work (reading, commenting, opening issues/PRs).
  Ask for approval only before destructive actions (deploys, deletes, data changes).

allowed_channels:
  - eng
  - incidents

models:
  default: openai:gpt-4.1-mini
  reasoning: anthropic:claude-sonnet
  cheap: openai:gpt-4.1-nano

tools:
  - slack.read_thread
  - github.search
  - github.read_pr
  - datadog.query
  - runbooks.search
  - github.create_issue        # non-destructive — no approval
  - deploy.rollback:
      approval_required: true   # destructive — approval required
```

---

## 6.3 Invoke an agent from Slack

User writes:

```text
@marathon bruce can you figure out why checkout errors increased today?
```

Marathon should:

1. Receive Slack event.
2. Authenticate Slack workspace.
3. Resolve the mention to the `bruce` agent (or the default agent if none is named).
4. Create durable task.
5. Reply quickly with acknowledgement.
6. Start execution asynchronously.
7. Load relevant Slack context.
8. Use tools.
9. Post progress updates.
10. Return final response in thread.
11. Offer feedback controls.

Example Slack thread:

```text
Tanton:
@marathon bruce can you figure out why checkout errors increased today?

Bruce:
I’ll investigate checkout errors using the current thread, recent deploys, and service logs.

Bruce:
I found a deploy to checkout-api at 9:42 AM and an error spike starting at 9:49 AM. I’m checking the PR and logs now.

Bruce:
Likely cause: PR #4812 changed payment retry handling and introduced a null path when provider metadata is missing.

Evidence:
1. Error spike begins 7 minutes after deploy.
2. Stack traces point to PaymentRetryPolicy.parse().
3. PR #4812 changed that function.
4. Rollback should be safe based on migration check.

Recommended next step:
Rollback checkout-api to version 2026.06.26.3.

Would you like me to open a GitHub issue with these findings?
```

---

## 6.4 Give feedback

User can react with:

* 👍 Helpful
* 👎 Not helpful

Feedback should be attached to:

* Task
* Agent
* Agent version
* Prompt version
* Model
* Tool calls
* Slack thread
* User
* Timestamp
* Final answer

This enables agent owners to understand failures and improve agents.

---

## 6.5 Human approval flow

Approval is requested only for **destructive** actions. For example, after investigating, Bruce proposes a rollback:

```text
I'd like to roll back checkout-api — this is a destructive action, so I need approval.

Action:
Roll back checkout-api to version 2026.06.26.3

Approve?
[Approve] [Reject] [Edit]
```

(Opening an issue or posting a summary would not prompt this — those are non-destructive and run automatically.)

If approved:

1. Approval is recorded.
2. Tool call executes.
3. Result is logged.
4. Slack thread is updated.

If rejected:

1. Task continues without action.
2. Rejection is logged.
3. Agent may ask for an alternative.

Approval should be requested and granted **in place** — inline in the Slack thread or the document (PR/comment) thread where the work is happening — not in a separate dashboard. Approval is only requested for destructive actions (§5.4); non-destructive work proceeds without it.

---

## 6.6 Retry failed task

A task fails because Datadog rate-limited the agent.

The agent should **retry automatically** (with backoff) for transient failures like this — it does not ask the user. The task state is checkpointed so the retry resumes where it left off. The agent only pauses to involve a human when the next step would be **destructive**, or when retries are exhausted:

```text
Bruce:
I hit a Datadog rate limit while checking logs and retried automatically.
Logs are still unavailable after several attempts — I'll continue with the
deploy timeline and PR diff, and note the gap in my findings.
```

Admin UI should show:

* Failed step
* Error
* Stack trace
* Tool input summary
* Retry count
* Task checkpoint
* Suggested remediation

---

## 6.7 Tag an agent into a document

A user `@mention`s an agent in a comment on a markdown file or pull request:

```text
@marathon quill summarize the open questions in this section and propose owners
```

Marathon should:

1. Receive the GitHub comment webhook (issue / PR / review comment).
2. Resolve the mention to the `quill` agent and the commenter to a Marathon user.
3. Check the user's and agent's access to the repository.
4. Create a durable task with `source_type: github` and the comment anchor (repo, path, line/comment id) in `source_ref`.
5. Reply in the comment thread to acknowledge.
6. Load the anchored region (the file, the diff hunk, or surrounding section as needed).
7. Do the work; post the result as a comment reply.
8. If asked to edit the document, open a pull request with the change (non-destructive); a human reviews and merges it (the agent does not merge on its own).
9. Offer feedback controls and record total cost.

---

## 6.8 Document-driven execution

For non-trivial work, the document *is* the workflow. A typical flow:

1. A user asks an agent to do something substantial in Slack (e.g. "ship rate-limiting for the public API").
2. The agent drafts a **design document** — a markdown file proposed as a pull request — describing the plan, scope, and risks.
3. People review and comment on the PR; the agent revises in response.
4. A human **approves by merging** the PR (the merge is the approval signal).
5. The agent then executes the approved plan, posting progress back to the Slack thread and the PR, and asking for approval only on destructive steps.

This makes the plan reviewable and auditable *before* execution, and keeps the durable record of intent in version control.
