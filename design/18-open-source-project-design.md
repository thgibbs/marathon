# 18. Open-source project design

## 18.1 Repository structure

Recommended monorepo:

```text
marathon/
  apps/
    api/
    web/
    worker/
    slack-gateway/
  packages/
    sdk-python/
    sdk-js/
    connector-sdk/
    model-gateway/
    tool-gateway/
    shared-types/
  connectors/
    github/
    slack/
    postgres/
    datadog/
    mcp/
  examples/
    agents/
      bruce-engineering-investigator/
      ada-code-reviewer/
      grace-data-analyst/
    docker-compose/
  docs/
  deploy/
    docker-compose/
    helm/
  tests/
  evals/
```

---

## 18.2 Default stack

Recommended MVP stack:

| Component      | Recommendation                       |
| -------------- | ------------------------------------ |
| API            | Fastify                              |
| Web UI         | Next.js                              |
| Worker         | TypeScript                           |
| Agent harness  | Pi (`@earendil-works/pi-coding-agent`, in-process SDK) |
| Model access   | Claude, ChatGPT, OpenRouter (minimal gateway) |
| Tool isolation | Container/VM + Gondolin or OpenShell (Pi has no sandbox) |
| Database       | Postgres                             |
| Queue          | Postgres + queue workers             |
| Object storage | S3-compatible optional               |
| Vector store   | Postgres pgvector initially          |
| Auth           | Built-in local auth, OIDC later      |
| Observability  | OpenTelemetry                        |
| Deployment     | Docker Compose first, Helm later     |

For durable workflows, there are two good directions:

### Option A: Temporal

Pros:

* Strong durable workflow semantics
* Retries/checkpointing built in
* Great fit for long-running tasks

Cons:

* More operational complexity
* Harder for simple local installs

### Option B: Postgres + queue workers

Pros:

* Simpler MVP
* Easier self-hosting
* Fewer dependencies

Cons:

* More custom reliability code
* Harder to get complex workflow semantics right

Recommendation:

> Start with Postgres-backed task state and a simple queue. Keep the task abstraction compatible with Temporal so advanced deployments can swap it in later.

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
