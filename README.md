# Marathon

Open-source platform for **durable AI agents that work where teams already work** —
Slack and GitHub-backed markdown documents. One loop is the product (design §0.1):

```text
Slack ask -> design-doc PR -> iterate on review -> merge-as-approval ->
sandboxed code work -> verified code PR -> links back to Slack and the doc PR
```

You `@marathon` an ask in Slack. The agent drafts a **design document as a markdown
PR**; you review and iterate in the PR; **merging it is the approval**. Marathon then
implements the merged plan in a **credential-free sandbox** (normal git, internet for
installs, the repo's own verification), pushes through a **credentialed broker**, opens
a code PR, and delivers the links back to the thread and the doc PR. Tasks are durable: a
clarifying question parks the task until you reply; a killed worker resumes mid-BUILD
without repeating work.

> **Status:** the kernel loop is functionally complete (roadmap K1–K5, migration
> tracks 1–17): durable spine, both surfaces, brokered `gh`/`git` delivery, per-turn
> checkpoint/resume, durable clarifying questions, YAML agent config, spec-driven
> models + hard per-task budgets, `@agent status` + cost footers, and the
> `make demo-kernel` regression umbrella. Remaining: the K6 timed stranger test and
> the K7 Claude Code harness (non-blocking); the "first blood" ratchet — a change to
> Marathon merged through its own loop — is the live bar (design §0.6).
>
> **Talk to it:** `make slack-app` runs the live listener — `@marathon …` in a channel
> the bot is in gets a real, threaded, durable agent reply. Replies in the thread
> answer its clarifying questions or chain follow-up tasks; `@marathon status` in a
> task's thread reports what it's doing, what's done, and cost so far (§15.3); final
> results carry a silent cost footer (§13.3).

## Quickstart

Requires Node >= 22, pnpm 10, Docker Compose for Postgres, and Docker for sandbox
demos/code tasks. Full walkthrough (Slack app, GitHub App, credentials, sandbox image):
**[`docs/quickstart.md`](./docs/quickstart.md)**.

```bash
pnpm install
make hooks               # gitleaks pre-commit secret scan (once)
make demo-kernel         # the K1-K5 umbrella: brokered delivery, sandbox network
                         # reality, fan-out, iteration continuity, kill/resume, status+cost
pnpm test && pnpm typecheck
```

Or piecewise: `demo-k1-brokered` (YAML grants → brokered `git push` / `gh pr create` →
report PR), `demo-k1-network` (credential-free sandbox with real internet; needs
Docker), `demo-k2` (fan-out to Slack + doc PR), `demo-k3` (clarify/resume/revision
continuity), `demo-k4` (kill mid-BUILD → resume → exactly one PR), `demo-k5`
(status + cost), `demo-slack-app`, `demo-github-app`.

All demos are deterministic (fakes/fixtures) and end with `demo-* OK`; `make demo` runs
the whole suite, kernel demos first. The network sandbox demo skips cleanly when Docker
is unavailable; database-backed demos still need Docker Compose. If host port 5432 is
taken: `make demo MARATHON_DB_PORT=55432`. Stop the database with `make down`.

## Agents are YAML

The deployment's agents live in [`agents/`](./agents) (first file = default agent).
The flagship is **Forge** ([`agents/forge.yaml`](./agents/forge.yaml)) — one agent that
spans the whole loop: it drafts the design doc *and* writes the code, against the ONE
configured repo (design §21.0):

```yaml
name: forge
harness: pi                   # claude-code lands with K7
repo: your-org/your-repo      # scopes every GitHub grant by construction
tools:
  - document.create           # design-doc PRs (a human merging = the approval)
  - tool: github.exec         # brokered gh — allowlisted command families
    families: ["pr view", "pr diff", "pr create", "pr edit"]
  - tool: git.exec            # brokered network git on the BUILD workspace
    families: ["push", "fetch"]
  - delivery.report_pr        # the narrow final step
sandbox: { network: bridge }  # internet for installs; NEVER any credentials
                              # ("none" from YAML, env, or code wins — strictness composes)
models: { default: openai:gpt-4o-mini }   # roles route models, e.g. build: openai:gpt-4o
budget: { limit_usd: 5 }      # hard cap — per agent AND per task; fails closed
```

Grants are enforced **by construction** (§7.8) — the repo allowlist, command families,
and branch namespace are structural, not prompt rules. Destructive actions (e.g. merge)
are never direct tools: the model proposes, a human approves, a non-model executor
performs (**Proposed Effects**, §7.9). Target repos declare their verification in a
repo-local `.marathon/config.yml` (`verify:` commands, §29.3). A red verify is delivered
honestly as a draft PR with the failure summary; Marathon should never claim green tests
it did not get.

## Docs

- [`docs/quickstart.md`](./docs/quickstart.md) — clone → compose → YAML agent → Slack +
  GitHub apps → first loop
- [`design/`](./design/index.md) — product + architecture design (start at
  [`design/00-core-kernel.md`](./design/00-core-kernel.md), the prioritization lens)
- [`roadmap.md`](./roadmap.md) — build-ordered plan (kernel K1–K7)
- [`code-migration.md`](./code-migration.md) — migration tracks from the M0–M9
  scaffolding to the kernel loop, with per-track status
- [`diagram.md`](./diagram.md) / [`diagram.html`](./diagram.html) — architecture diagram
- [`pi-details.md`](./pi-details.md) — Pi harness integration reference
- [`PREREQUISITES.md`](./PREREQUISITES.md) — human setup (accounts, keys, billing caps)

## Secret scanning (pre-commit)

Secrets live only in a git-ignored `.env` (see `.env.example`), never in code.
`make hooks` enables a version-controlled **gitleaks** pre-commit hook
(`.githooks/pre-commit`, config in `.gitleaks.toml`) that blocks commits containing
secrets (`brew install gitleaks` once). Scan the whole repo + history with
`make secret-scan`. Pair with GitHub **push protection** server-side. The GitHub token
itself is *brokered*: injected host-side into `github.exec`/`git.exec` child processes
only — never in the sandbox, prompt, or trace.

## Layout

```
packages/
  config/    @marathon/config   — env config, secret store, YAML agent specs (Track 14)
  core/      @marathon/core     — domain types, task state machine, audit, idempotency
  db/        @marathon/db       — Postgres schema/migrations + data access
  queue/     @marathon/queue    — durable Postgres job queue + retry/backoff
  worker/    @marathon/worker   — orchestrator + agent worker (checkpoint/resume, briefs, seeding)
  model-gateway/ @marathon/model-gateway — model specs, routing, cost, keys
  agent/     @marathon/agent    — AgentRuntime seam: Pi adapter, fakes, BUILD sandbox factory
  tools/     @marathon/tools    — tool gateway (embedded permissioning), command broker, effects
  code-handoff/ @marathon/code-handoff — BUILD workspace, verify discovery, code-change records
  connector-github/ @marathon/connector-github — GitHub tools: reads, documents, exec broker, delivery
  surface/   @marathon/surface  — SurfaceAdapter seam: invocation, agent selection, fan-out
  surface-slack/ @marathon/surface-slack — Slack: signature, parse, delivery, Socket Mode
  surface-github/ @marathon/surface-github — GitHub webhooks: signature + event parsing
  memory/    @marathon/memory   — swappable MemoryStore (pgvector default, Mem0 adapter)
  observability/ @marathon/observability — task timeline, cost rollups, budgets, metrics
  slack-app/ @marathon/slack-app — live Slack app: bootstrap, dispatch, Socket Mode wiring
  github-app/ @marathon/github-app — live GitHub app: document webhooks + BUILD worker
agents/      YAML agent definitions (forge.yaml — the flagship)
demos/       deterministic kernel + milestone demos (k1–k5 variants, m0–m9, apps)
docker/      pinned BUILD sandbox toolchain image (make sandbox-image)
```

Real adapters are runtime-verified locally (need keys/tokens in `.env`):
`make smoke-pi` (live model call), `make smoke-github` / `-write` / `-doc` (real repo),
`make smoke-k4` (real Pi BUILD, kill + resume), `make smoke-sandbox` / `-broker` /
`-container` (sandbox seams), and `make smoke-slack`. CI uses fakes/fixtures.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
