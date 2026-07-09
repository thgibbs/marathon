# 31. Acknowledge via reaction, not text (Slack + GitHub)

> **Status: proposed (2026-07-09).** Requested directly: replace the `"_on it…_"`
> acknowledgement message with a :+1: reaction on the triggering message/comment, on both
> Slack and GitHub. Small, surface-adapter-scoped change — no new user-facing surface, no
> schema change.

## 31.1 Motivation

`acknowledge()` exists purely to signal receipt before a task starts running (§15.2 "post
acknowledgement immediately"). Today both surfaces do that by posting a full text
message/comment (`"_on it…_"`). A reaction is quieter and carries the same signal with less
channel/thread noise, and it puts Slack and GitHub on the same acknowledgement primitive
instead of "post text" on one and (potentially) something else on the other. This section
scopes the change to `acknowledge()` only — `postProgress`/`deliverResult` keep posting text;
substantive updates should stay visible.

## 31.2 Current behavior

* `SlackDelivery.acknowledge` (`packages/surface-slack/src/delivery.ts`) posts `"_on it…_"`
  as a new thread message via `client.postMessage`.
* `GithubDelivery.acknowledge` (`packages/connector-github/src/delivery.ts`) posts
  `"_on it…_"` as a new issue/PR comment via `client.commentIssue`.

Both implement the shared `SurfaceAdapter.acknowledge(ref)` contract (§7.16,
`packages/surface/src/types.ts`); the contract itself ("signal receipt") doesn't change, only
how each surface fulfills it.

## 31.3 New behavior

`acknowledge()` adds a :+1: reaction to the message/comment that triggered the task, instead
of posting new text:

* **Slack** — react to the specific mention or thread-reply message that started the task.
* **GitHub** — react to the specific comment (`issue_comment` or
  `pull_request_review_comment`) that mentioned `@marathon`.

## 31.4 Threading the reaction target through

Reacting needs the triggering message/comment's own identity, not just its channel/issue.
Neither surface's `sourceRef` carries that all the way to `acknowledge()` today:

**GitHub.** `classifyGithubEvent` (`packages/surface-github/src/parse.ts`) already puts
`comment_id` on `sourceRef` for both comment event types. But `handleGithubMention`
(`packages/github-app/src/handlers.ts`) calls
`deps.delivery.acknowledge({ repo, number })` — a fresh object built from the invocation,
dropping `comment_id`. Fix: pass it through —
`deps.delivery.acknowledge({ repo, number, commentId: invocation.sourceRef.comment_id })`.

Issue comments and PR review comments are different GitHub objects with different reaction
endpoints (`POST /repos/{owner}/{repo}/issues/comments/{id}/reactions` vs.
`POST /repos/{owner}/{repo}/pulls/comments/{id}/reactions`), so the target also needs to carry
*which kind* of comment it is. `sourceRef` already distinguishes the two events structurally
(`pull_request_review_comment` sets `path`/`line`; `issue_comment` doesn't) — thread an
explicit `commentType: "issue" | "review"` field through alongside `comment_id` rather than
inferring it downstream from presence-of-`path`.

**Slack.** `sourceRef` today carries only the thread's anchor timestamp
(`thread_ts: event.thread_ts ?? event.ts`) — for a mention that starts a new thread this
happens to equal the message's own `ts`, but for a mention or reply *inside* an existing
thread, the message's own `ts` is never captured; only the thread anchor is. Reacting to
`thread_ts` in that case puts the :+1: on the wrong (earlier) message. Fix: add the message's
own `ts` to `sourceRef` in both `parseAppMention` and `parseThreadReply`
(`packages/surface-slack/src/parse.ts`), and have `SlackDelivery.acknowledge` react to `ts`
(falling back to `thread_ts` if `ts` is absent, so any other caller of `acknowledge` with a
minimal ref still works).

## 31.5 Client interface additions

* `SlackClient.addReaction(channel: string, ts: string, reaction: string): Promise<void>` —
  wraps `reactions.add`. Add to both `RealSlackClient` and `FakeSlackClient` (recording added
  reactions the same way `FakeSlackClient` records posted messages, for test assertions).
* `GithubClient.addIssueCommentReaction(repo: string, commentId: number, reaction: string): Promise<void>`
  and `addReviewCommentReaction(repo: string, commentId: number, reaction: string): Promise<void>`
  — two methods (not one), matching the two distinct GitHub endpoints from §31.4. Add to both
  the real and fake `GithubClient` implementations
  (`packages/connector-github/src/client.ts`), fake recording writes the same way
  `commentIssue` does today.

`GithubDelivery.acknowledge` and `SlackDelivery.acknowledge` route to the right client method
using the `commentType`/`ts` fields threaded through in §31.4.

## 31.6 The self-feedback bug this change would introduce — and its fix

Slack already treats a :+1: reaction as user feedback: `handleReaction` →
`parseReactionFeedback` → `recordFeedback` (`packages/slack-app/src/handlers.ts`,
`packages/surface-slack/src/parse.ts`) runs for **any** `reaction_added` event with no check
on who added it. Once `acknowledge()` itself adds a :+1:, every acknowledged mention would
generate a `reaction_added` event authored by the bot's own Slack user — and get recorded as
a `thumbs_up` feedback event. That's a real bug this change would otherwise introduce, not a
hypothetical: the bot would be silently rating every task it starts as positively-received
before doing any work.

**Fix.** Ignore reactions from the bot's own Slack user id.

* The bot's user id is already available at boot: `startSlackApp`
  (`packages/slack-app/src/app.ts`) calls Slack's `auth.test` and reads `team`/`team_id` from
  the response today; `auth.test` also returns `user_id` (the bot's own user id) — capture it
  the same way.
* Add `botUserId: string` to `AppDeps` (`packages/slack-app/src/handlers.ts`), threaded from
  `startSlackApp`'s `deps` construction.
* `handleReaction` short-circuits when `fb.userExternalId === deps.botUserId`, before calling
  `recordFeedback`.

GitHub has no equivalent bug: nothing in `packages/github-app` currently reads reactions as a
feedback signal, so a bot-added reaction there has no misinterpretation path to guard against.

## 31.7 Failure handling

Reacting can fail on both surfaces (comment/message deleted before the reaction lands, an
`item_not_found`/`404`-shaped error, rate limiting). `acknowledge()` is a best-effort signal,
not load-bearing for task correctness — mirror the existing `loadContext` pattern
(`.catch(() => undefined)` at the call site in `handleGithubMention`) and let both
`acknowledge()` implementations swallow the error rather than fail the task.

## 31.8 Scope boundary

Only `acknowledge()` changes. `postProgress` and `deliverResult` keep posting text — the
request was specifically to replace the "on it…" ack, and substantive updates/results should
stay visible as messages/comments, not reactions.

## 31.9 Testing

* Slack: `parseAppMention`/`parseThreadReply` unit tests assert `ts` is present and distinct
  from `thread_ts` for in-thread mentions/replies; `SlackDelivery.acknowledge` test asserts
  `FakeSlackClient` recorded a reaction on the message's own `ts`, not the thread anchor.
* GitHub: `classifyGithubEvent` tests already cover `comment_id`; add coverage that
  `handleGithubMention` calls `acknowledge` with `commentId` + the right `commentType` for
  both `issue_comment` and `pull_request_review_comment` sources; `GithubDelivery.acknowledge`
  test asserts the fake client recorded a reaction via the endpoint matching `commentType`.
* Slack self-feedback: `handleReaction` test asserts a `reaction_added` event where
  `event.user === botUserId` does **not** call `recordFeedback`, and that a genuine user
  reaction still does.

## 31.10 Open questions

None blocking — this is a self-contained adapter-level change with no data model or policy
impact.
