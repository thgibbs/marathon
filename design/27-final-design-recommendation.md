# 27. Final design recommendation

Marathon should be designed around one central abstraction:

## The durable agent task

Everything else supports that abstraction.

An invocation from any surface — a Slack message, a document mention — creates a task.

The task chooses an agent version.

The agent runs steps.

Steps call models and tools.

Tools are permissioned.

High-risk effects are proposed, human-reviewed, and performed by a non-model executor (§7.9); reversible, audience-bounded work runs autonomously.

Every action is logged.

The user gets progress and a final answer on the surface they invoked from.

Feedback improves future versions.

That is the product.

The architecture, UI, SDK, connector system, and evaluation loop should all reinforce this central idea.
