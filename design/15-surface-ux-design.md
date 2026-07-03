# 15. Surface UX design

The patterns below use Slack as the running example, but they are surface-agnostic: each applies to documents and other surfaces, with native rendering noted where it differs. See §15.6 for document-specific UX.

## 15.1 Agent tone

Agents should be:

* Clear
* Concise
* Evidence-based
* Honest about uncertainty
* Explicit about actions taken
* Respectful of Slack noise
* **Attributed** — every message names the acting agent (all agents share the single `@marathon` bot identity, §7.1), so users can tell *which* agent — and therefore which tool grants — acted

Default response structure for investigation agents:

```text
Summary
Evidence
Recommendation
Actions taken
Open questions
```

---

## 15.2 Progress updates

Progress updates should be specific and useful but not spammy.

Good:

```text
I found a likely related deploy (id #) and am checking logs now.
```

Bad:

```text
Step 14/87 complete.
```

Default progress policy:

* Post acknowledgement immediately.
* Post update after meaningful milestone.
* Post update when waiting for approval.
* Post update on failure.
* Post final answer.
* Avoid updates more often than every 30–60 seconds unless interactive.
* On Slack, progress posts are separate thread messages under this cadence; on the document surface, progress **edits the single acknowledgement reply** instead (§15.6).

---

## 15.3 Task status

User can ask:

```text
@bruce status
```

Response:

```text
Still running.

Current step:
Checking Datadog logs for checkout-api errors between 9:30 and 10:15 AM.

Completed:
- Read Slack thread
- Found recent deploy
- Read PR #4812
```

---

## 15.4 Cancellation

> **Not in the initial release.** User-initiated cancellation is deferred; the patterns below are documented for later. Initially, tasks run to completion, fail, or time out.

User can write:

```text
@bruce cancel
```

or click:

```text
[Cancel task]
```

Cancellation behavior:

* Mark task as cancelling.
* Stop new model/tool calls.
* Allow current safe call to finish or timeout.
* Post cancellation confirmation.
* Persist partial findings.

---

## 15.5 Final answer format

The final answer is a **structured result** that each surface renders natively (a threaded Slack message, a formatted document or comment, a web record). It should include:

* Direct answer
* Confidence level
* Evidence
* Actions taken
* Suggested next step
* Feedback controls
* Total cost (silent footer; see §13.3)

Example:

```text
Likely cause: PR #4812 introduced a null handling bug in payment retry metadata.

Confidence: High

Evidence:
1. Error spike started 7 minutes after deploy.
2. Stack traces point to PaymentRetryPolicy.parse().
3. PR #4812 changed that function.
4. Logs show missing provider_metadata on failed requests.

Recommended next step:
Rollback checkout-api to version 2026.06.26.3.

I did not make any production changes.
```

---

## 15.6 Document surface UX

When invoked on a document (GitHub markdown):

* Acknowledge with a quick reply in the comment thread on the mention.
* Post progress by editing that reply (not many new comments).
* Deliver the structured result as a comment reply by default; when producing or changing a document, open a pull request and link it from the reply.
* For edits, propose a pull request or review suggestion (native review — the merge is the approval, §7.8) rather than committing silently to a shared branch.
* Respect repository permissions; visibility or settings changes are high-risk and route through a `propose_effect` (§7.9).
