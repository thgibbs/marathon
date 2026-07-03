SHELL := /bin/bash
# Host port for the dockerized Postgres. Override if 5432 is taken locally,
# e.g. `make demo-m0 MARATHON_DB_PORT=55432`.
MARATHON_DB_PORT ?= 5432
DATABASE_URL ?= postgres://marathon:marathon@localhost:$(MARATHON_DB_PORT)/marathon
export DATABASE_URL MARATHON_DB_PORT

.PHONY: install hooks secret-scan db-up db-down migrate typecheck test demo demo-k1 demo-k1-brokered demo-k4 demo-m0 demo-m1 demo-m2 demo-m3 demo-m4 demo-m5 demo-m6 demo-m6.1 demo-m7 demo-m8 demo-m9 demo-github-app demo-slack-app slack-app github-app smoke-pi smoke-github smoke-github-write smoke-github-doc smoke-pi-tools smoke-mem0 smoke-sandbox smoke-broker smoke-container smoke-pi-sandbox smoke-k4 smoke-slack down

install:
	pnpm install

# Enable the version-controlled git hooks (gitleaks secret scan on commit).
hooks:
	git config core.hooksPath .githooks
	@command -v gitleaks >/dev/null 2>&1 || echo "note: install gitleaks for the hook to run — 'brew install gitleaks'"
	@echo "git hooks enabled (core.hooksPath=.githooks)"

# Scan the whole repo + history for secrets (what CI/the hook use).
secret-scan:
	gitleaks detect --redact --config .gitleaks.toml

db-up:
	docker compose up -d --wait db

db-down:
	docker compose down

migrate: db-up
	pnpm --filter @marathon/db migrate

typecheck:
	pnpm typecheck

test:
	pnpm test

# Kernel demos (design §0.6, roadmap §2c) come first: the loop is the critical path.
# K1: fake merged plan -> workspace edits -> verify -> handoff -> branch + PR (design §29).
demo-k1:
	pnpm --filter @marathon/demo-k1 start

# K1 corrected path (code-migration.md Tracks 6-9): agent-driven delivery —
# brokered `git push` + `gh pr create` (credentials host-side only) ->
# delivery.report_pr fan-out -> model-initiated merge as a Proposed Effect
# performed by a non-model executor.
demo-k1-brokered:
	pnpm --filter @marathon/demo-k1-brokered start

# K4: kill a multi-turn BUILD run mid-flight -> a fresh worker resumes from the
# per-turn checkpoint (session + workspace diff) -> exactly one PR (design §11.2, §29).
demo-k4: db-up migrate
	pnpm --filter @marathon/demo-k4 start

demo-m0: db-up migrate
	pnpm --filter @marathon/demo-m0 start

demo-m1: db-up migrate
	pnpm --filter @marathon/demo-m1 start

demo-m2: db-up migrate
	pnpm --filter @marathon/demo-m2 start

demo-m3: db-up migrate
	pnpm --filter @marathon/demo-m3 start

demo-m4: db-up migrate
	pnpm --filter @marathon/demo-m4 start

demo-m5: db-up migrate
	pnpm --filter @marathon/demo-m5 start

demo-m6: db-up migrate
	pnpm --filter @marathon/demo-m6 start

demo-m6.1: db-up migrate
	pnpm --filter @marathon/demo-m6-1 start

demo-m7: db-up migrate
	pnpm --filter @marathon/demo-m7 start

demo-m8: db-up migrate
	pnpm --filter @marathon/demo-m8 start

demo-m9: db-up migrate
	pnpm --filter @marathon/demo-m9 start

demo-github-app: db-up migrate
	pnpm --filter @marathon/demo-github-app start

demo-slack-app: db-up migrate
	pnpm --filter @marathon/demo-slack-app start

# Run the LIVE Slack app (long-running; needs Slack + model keys in .env).
slack-app: db-up migrate
	set -a; . ./.env; set +a; pnpm --filter @marathon/demo-slack-app live

# Run the LIVE GitHub document app (webhook receiver; needs a tunnel + keys).
github-app: db-up migrate
	set -a; . ./.env; set +a; pnpm --filter @marathon/demo-github-app live

# Local-only smokes against real services (need keys/tokens). Not run in CI.
smoke-pi:
	pnpm --filter @marathon/demo-m2 smoke

smoke-github:
	pnpm --filter @marathon/demo-m3 smoke

smoke-github-write:
	pnpm --filter @marathon/demo-m5 smoke

smoke-github-doc:
	pnpm --filter @marathon/demo-m6 smoke

smoke-pi-tools:
	pnpm --filter @marathon/demo-m6-1 smoke

smoke-mem0:
	pnpm --filter @marathon/demo-m7 smoke

smoke-sandbox:
	pnpm --filter @marathon/demo-m9 smoke-sandbox

smoke-broker:
	pnpm --filter @marathon/demo-m9 smoke-broker

smoke-container:
	pnpm --filter @marathon/demo-m9 smoke-container

smoke-pi-sandbox:
	pnpm --filter @marathon/demo-m9 smoke-pi-sandbox

# K4 live: kill a REAL Pi code-writing run (sandboxed tools in Docker) mid-BUILD,
# then resume it to a single PR. Needs Docker + Postgres + a model key.
smoke-k4: db-up migrate
	pnpm --filter @marathon/demo-k4 smoke

smoke-slack:
	pnpm --filter @marathon/demo-m4 smoke

# Runs the full demo chain (grows as milestones land).
demo: demo-k1 demo-k1-brokered demo-k4 demo-m0 demo-m1 demo-m2 demo-m3 demo-m4 demo-m5 demo-m6 demo-m6.1 demo-m7 demo-m8 demo-m9 demo-github-app demo-slack-app

down: db-down
