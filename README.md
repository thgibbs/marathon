# Marathon

Open-source platform for durable AI agents that work where teams already work —
**Slack** and **GitHub-backed markdown documents** — built on the **Pi** agent harness.

> Status: early implementation. The design is settled; code is being built milestone by
> milestone (see `roadmap.md`). **M0 (foundations)**, **M1 (durable task spine)**,
> **M2 (Pi harness seam + minimal model gateway)**, **M3 (tool layer with embedded
> permissioning + first tools)**, **M4 (Slack surface)**, **M5 (destructive-action
> approval + GitHub write tools)**, **M5.5 (live Slack app — Socket Mode listener)**, and
> **M6 (GitHub document surface + document-driven workflow)** are in place — the full
> MVP (M0–M6) — plus the live-integration follow-ons **M6.1 (governed tools in the live
> agent)** and **M6.2 (live GitHub document app — webhook receiver)**.
>
> **Talk to it:** `make slack-app` runs the live listener — then `@marathon …` in a
> channel the bot is in to get a real, threaded, agent reply.

## Docs

- [`design/`](./design/index.md) — product + architecture design (split into per-section
  notes; start at [`design/index.md`](./design/index.md))
- [`roadmap.md`](./roadmap.md) — build-ordered implementation plan (M0–M9; MVP = M0–M6)
- [`diagram.md`](./diagram.md) / [`diagram.html`](./diagram.html) — architecture diagram
- [`pi-details.md`](./pi-details.md) — Pi harness integration reference
- [`PREREQUISITES.md`](./PREREQUISITES.md) — human setup (accounts, keys, etc.)

## Quickstart (M0)

Requires Node ≥ 22, pnpm, and Docker.

```bash
pnpm install
make hooks        # enable the gitleaks pre-commit secret scan (do this once)
make demo         # boots Postgres, migrates, runs all milestone demos (m0, m1)
pnpm test         # unit tests
pnpm typecheck
```

Each demo ends with `demo-mN OK`. Run one with `make demo-m0` / `make demo-m1`. If host
port 5432 is already in use (e.g. a local Postgres), pick another:
`make demo MARATHON_DB_PORT=55432`. Stop the database with `make down`.

### Secret scanning (pre-commit)

Secrets live only in a git-ignored `.env` (see `.env.example`), never in code. To prevent
accidental commits, `make hooks` enables a version-controlled **gitleaks** pre-commit hook
(`.githooks/pre-commit`, config in `.gitleaks.toml`) that scans staged changes and blocks the
commit if it finds a secret. Install gitleaks once (`brew install gitleaks`). Scan the whole
repo + history anytime with `make secret-scan`. Pair with GitHub **push protection** as the
server-side backstop.

## Layout

```
packages/
  config/   @marathon/config  — config + secret-store abstraction
  core/     @marathon/core     — domain types, task state machine, audit, idempotency
  db/        @marathon/db       — Postgres schema/migrations + data access
  queue/     @marathon/queue    — durable Postgres job queue + retry/backoff
  worker/    @marathon/worker   — orchestrator + agent worker (checkpoint/resume)
  model-gateway/ @marathon/model-gateway — model specs, routing, cost, keys
  agent/     @marathon/agent    — AgentRuntime seam: FakeAgentRuntime + real Pi adapter
  tools/     @marathon/tools    — tool layer: policy, gateway (embedded permissioning), CLI
  connector-github/ @marathon/connector-github — GitHub tools (read + write; HTTP + fixtures)
  surface/   @marathon/surface  — SurfaceAdapter seam: invocation, agent selection, rendering
  surface-slack/ @marathon/surface-slack — Slack: signature, parse, delivery, Socket Mode
  memory/    @marathon/memory   — swappable MemoryStore (pgvector default, Mem0 adapter) + embedders
  surface-github/ @marathon/surface-github — GitHub webhooks: signature + event parsing
  slack-app/ @marathon/slack-app — live Slack app: bootstrap, dispatch, Socket Mode wiring
  github-app/ @marathon/github-app — live GitHub document app: webhook receiver + dispatch
demos/
  m0/        @marathon/demo-m0  — foundations demo
  m1/        @marathon/demo-m1  — durable-spine demo (crash mid-run, resume once)
  m2/        @marathon/demo-m2  — agent loop via the runtime (fake model), cost, resume
  m3/        @marathon/demo-m3  — tools under policy: allow/deny, audit, no creds in trace
  m4/        @marathon/demo-m4  — Slack mention -> task -> read tool -> threaded reply + feedback
  m5/        @marathon/demo-m5  — destructive-action approval (block/approve/reject/expire), idempotent
  m6/        @marathon/demo-m6  — document-driven workflow: mention -> draft PR -> merge -> execute
  m6_1/      @marathon/demo-m6-1 — governed tools in the agent loop (allow/approve/audit)
  github-app/ @marathon/demo-github-app — webhook receiver demo + live runner (make github-app)
  m7/        @marathon/demo-m7  — memory: scope×term recall, isolation, feedback→memory, prompt assembly
```

Real adapters are runtime-verified locally (need keys/tokens in `.env`):
`make smoke-pi` (live model call), `make smoke-github` / `make smoke-github-write`
(real repo read/write), and `make smoke-slack` (auth + Socket Mode + optional post).
CI uses fakes/fixtures for determinism.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
