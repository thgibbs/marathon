# Marathon

Open-source platform for durable AI agents that work where teams already work —
**Slack** and **GitHub-backed markdown documents** — built on the **Pi** agent harness.

> Status: early implementation. The design is settled; code is being built milestone by
> milestone (see `roadmap.md`). **M0 (foundations)** is in place.

## Docs

- [`design.md`](./design.md) — product + architecture design
- [`roadmap.md`](./roadmap.md) — build-ordered implementation plan (M0–M9; MVP = M0–M6)
- [`diagram.md`](./diagram.md) / [`diagram.html`](./diagram.html) — architecture diagram
- [`pi-details.md`](./pi-details.md) — Pi harness integration reference
- [`PREREQUISITES.md`](./PREREQUISITES.md) — human setup (accounts, keys, etc.)

## Quickstart (M0)

Requires Node ≥ 22, pnpm, and Docker.

```bash
pnpm install
make demo-m0      # boots Postgres, migrates, runs the M0 foundations demo
pnpm test         # unit tests
pnpm typecheck
```

`make demo-m0` should end with `demo-m0 OK`. If host port 5432 is already in use
(e.g. a local Postgres), pick another: `make demo-m0 MARATHON_DB_PORT=55432`.
Stop the database with `make down`.

## Layout

```
packages/
  config/   @marathon/config  — config + secret-store abstraction
  core/     @marathon/core     — domain types, task state machine, audit
  db/        @marathon/db       — Postgres schema/migrations + data access
demos/
  m0/        @marathon/demo-m0  — automated M0 demo
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
