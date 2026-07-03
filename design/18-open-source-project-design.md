# 18. Open-source project design

## 18.1 Repository structure

The monorepo, as built (pnpm workspaces):

```text
marathon/
  packages/
    core/               # task engine: orchestrator, state machine, approvals
    queue/              # Postgres-backed durable queue (leases, heartbeats, retries)
    db/                 # schema + migrations
    agent/              # AgentRuntime seam (PiAgentRuntime, FakeAgentRuntime, sandbox routing)
    worker/             # durable agent worker
    tools/              # ToolGateway + governed tools
    connector-github/   # GitHub connector
    surface/            # SurfaceAdapter seam
    surface-slack/      # Slack surface (parse, context, delivery)
    surface-github/     # GitHub document surface
    slack-app/          # live Slack app (Socket Mode listener)
    github-app/         # live GitHub webhook receiver
    memory/             # MemoryStore seam + pgvector / Mem0 / fake adapters
    model-gateway/      # minimal model gateway (policy, refs, cost)
    observability/      # timeline, cost rollups, budgets, metrics
    config/             # config loading (incl. YAML agent definitions)
  demos/                # per-milestone automated demos (demos/mN — CI regression guards)
  design/               # this design guide
  docker-compose.yml
```

Future additions when their milestones land: a web app for the Agent Hub + inspectability
dashboard (M10), `deploy/helm`, and example agent definitions.

---

## 18.2 Default stack

Recommended MVP stack:

| Component      | Recommendation                       |
| -------------- | ------------------------------------ |
| API            | Fastify                              |
| Web UI         | Next.js                              |
| Worker         | TypeScript                           |
| Agent harness  | **Pi** (in-process SDK) or **Claude Code** (headless subprocess) — one per deployment, behind `AgentRuntime` (K7) |
| Model access   | Claude, ChatGPT, OpenRouter (minimal gateway) |
| Tool isolation | Container/VM + Gondolin or OpenShell (Pi has no sandbox) |
| Database       | Postgres                             |
| Queue          | Postgres + queue workers             |
| Object storage | S3-compatible optional               |
| Vector store   | Postgres pgvector initially          |
| Auth           | Built-in local auth, OIDC later      |
| Observability  | OpenTelemetry                        |
| Deployment     | Docker Compose first, Helm later     |

For durable workflows, the decision is **Postgres + queue workers** — Marathon owns its
durable execution rather than adopting a workflow engine:

* Simpler MVP and self-hosting; fewer dependencies.
* The cost is custom reliability code (leases, heartbeats, retries, checkpoints) — accepted:
  that machinery is built and CI-tested (roadmap M1), and durable state is where much of
  Marathon's value lives (§27, §28).
* The queue is **Temporal-shaped** — durable jobs, worker leases/heartbeats, visibility
  timeouts, retries with backoff, at-least-once delivery made safe by idempotent effects —
  because those are the right semantics, **not** because a Temporal swap is planned. There is
  **no compatibility hedge**: Marathon's durability model (persist an opaque Pi session,
  resume between turns — §11.6) is not workflow-engine deterministic replay, and a later swap
  would be a rewrite regardless of interface discipline.

---

## 18.3 Licensing

Recommended license:

* Apache 2.0 for broad commercial adoption
* MIT for maximum simplicity

Apache 2.0 may be better if the project expects enterprise use because of explicit patent grants.

---

## 18.4 Contribution model

Open-source success requires:

* Clear README
* Local quickstart
* Good first issues
* Example agents
* Example connectors
* Architecture docs
* Security policy
* Contributor guide
* Plugin development guide
* Roadmap
