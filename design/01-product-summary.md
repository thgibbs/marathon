# 1. Product summary

**Marathon** is an open-source platform for building, deploying, and operating AI agents that work where teams already work — chat (Slack) and markdown documents in GitHub first, with more surfaces to follow.

The core idea is simple:

> Users invoke named agents from the surfaces they already use. Agents run durable long-running tasks, use approved internal tools, ask for human approval when needed, report progress back on the originating surface, and produce auditable, feedback-driven outputs — including documents they create and maintain.

Marathon is not just a chatbot. It is an **agent operations platform** for teams that want AI agents to work safely inside real company workflows.

Example usage:

```text
@bruce investigate why checkout latency spiked this morning
```

Bruce may then:

1. Read the Slack thread.
2. Search recent GitHub changes.
3. Query observability tools.
4. Check an incident runbook.
5. Ask for approval only before a destructive action (e.g., triggering a rollback); opening an issue or posting an update is non-destructive and needs none.
6. Summarize findings in the Slack thread.
7. Store task traces, tool calls, costs, and feedback for later review.

The codename **Marathon** fits because the platform is optimized for **long-running, durable, checkpointed AI work**, not one-off chat completions.
