# 25. Recommended first implementation

The first useful version of Marathon should be small but real.

## Build this first

1. Slack app receives mentions.
2. Message creates durable task.
3. Task runs in worker.
4. Agent uses one model provider.
5. Agent replies in Slack thread.
6. Task history visible in admin UI.
7. Feedback stored.
8. GitHub read-only connector works.
9. Tool calls are logged.
10. Docker Compose runs everything locally.

## First demo scenario

Use `@bruce` as the flagship demo agent.

Demo prompt:

```text
@marathon bruce summarize this PR and identify risks
```

Bruce should:

1. Read the Slack thread.
2. Extract GitHub PR link.
3. Read PR metadata and diff summary.
4. Produce a risk summary.
5. Comment on the PR with the summary (reversible, same-repo audience — autonomous under §7.8).
6. Log the full task trace.
7. Accept thumbs up/down feedback.

This demo proves:

* Slack invocation
* Durable task creation
* Tool access
* Slack response
* Auditability
* Feedback loop
* Open-source developer value
