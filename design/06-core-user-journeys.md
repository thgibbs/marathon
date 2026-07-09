# 6. Core user journeys

## 6.1 Install Marathon into Slack

Admin flow:

1. Admin deploys Marathon.
2. Admin opens setup UI.
3. Admin connects Slack workspace.
4. Admin grants Slack app permissions.
5. Admin configures model provider.
6. Admin defines the first agent (a YAML file — see §6.2).
7. Admin invites users or enables selected channels.
8. User invokes the first agent.

Success criterion:

> A new tenant can install Marathon, configure one model provider, create one agent, and invoke it from Slack.

---

## 6.2 Create an agent

> Initial scope: agents are defined in a **simple YAML config format** (the example below), loaded from the deployment's config — written by the operator/admin, versioned in git, applied by redeploy/restart. Deliberately hard to change at first: **no GUI, no hot-swapping, no external SDK**. The admin-UI flow below is documented for direction only.

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
  Act autonomously for reversible, audience-bounded work (reading, commenting, opening issues/PRs).
  Propose high-risk effects (deploys, deletes, data changes) for human review — never execute them directly.

allowed_channels:
  - eng
  - incidents

models:
  default: openai:gpt-4o-mini
  reasoning: openai:gpt-4o
  cheap: openai:gpt-4o-mini

tools:
  - slack.read_thread
  - github.search
  - github.read_pr
  - datadog.query
  - runbooks.search
  - github.create_issue        # reversible, repo audience — autonomous
  # High-risk effects are never direct tools (§7.9). A rollback is proposed:
  #   propose_effect(effect_type: deploy_rollback, target: checkout-api, ...)
  # and performed by the non-model executor only after human approval.
effects:
  - deploy_rollback             # effect type this agent may propose
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

Human review is requested only for **high-risk** effects — irreversible, cross-trust-boundary, public/external, or costly (§7.8). A rollback is irreversible, so Bruce cannot execute it directly; he *proposes* it (§7.9):

```text
I'd like to roll back checkout-api — that's irreversible, so I've proposed it for approval.

Proposed effect:
Roll back checkout-api to version 2026.06.26.3

Approve?
[Approve] [Reject] [Edit]
```

(Opening an issue or posting a summary in this thread would not prompt this — those are reversible and audience-bounded, and run automatically.)

If approved:

1. The approval is recorded, bound to the exact proposed artifact (payload hash — §7.9).
2. The non-model executor performs the effect.
3. Result is logged.
4. Slack thread is updated.

If rejected:

1. Task continues without action.
2. Rejection is logged.
3. Agent may ask for an alternative.

Review should be requested and granted **in place** — inline in the Slack thread or the document (PR/comment) thread where the work is happening (the Agent Hub is a complementary queue over the same proposal records — §7.9). Review is requested only for high-risk effects (§5.4); reversible, audience-bounded work proceeds without it.

---

## 6.6 Retry failed task

A task fails because Datadog rate-limited the agent.

The agent should **retry automatically** (with backoff) for transient failures like this — it does not ask the user. The task state is checkpointed so the retry resumes where it left off. The agent only pauses to involve a human when the next step is a **high-risk effect** (which routes to a proposal — §7.9), or when retries are exhausted:

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
8. If asked to edit the document, open a pull request with the change (native review — §7.8); a human reviews and merges it (the agent does not merge on its own).
9. Offer feedback controls and record total cost.

---

## 6.8 Document-driven execution

For non-trivial work, the document *is* the workflow. A typical flow:

1. A user asks an agent to do something substantial in Slack (e.g. "ship rate-limiting for the public API").
2. The agent drafts a **design document** — a markdown file proposed as a **draft pull request against the default branch** (§29.1a) — describing the plan, scope, and risks.
3. People review and comment on the PR; the agent revises in response.
4. A human **approves by submitting an approving review** on the draft PR (the review is the approval signal — it pins the PR head SHA; the approver must have write access; the default branch is untouched).
5. The agent then executes the approved plan **on the same branch**, posting progress back to the Slack thread and the PR, routing any high-risk step through a proposal (§7.9). The PR — now carrying **plan doc + code together** — is marked ready for review, so the plan reaches the default branch only when the work merges: an abandoned plan is a closed draft PR, and a plan doc on main always means the plan shipped.

This makes the plan reviewable and auditable *before* execution, and keeps the durable record of intent in version control.
