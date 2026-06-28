SHELL := /bin/bash
# Host port for the dockerized Postgres. Override if 5432 is taken locally,
# e.g. `make demo-m0 MARATHON_DB_PORT=55432`.
MARATHON_DB_PORT ?= 5432
DATABASE_URL ?= postgres://marathon:marathon@localhost:$(MARATHON_DB_PORT)/marathon
export DATABASE_URL MARATHON_DB_PORT

.PHONY: install db-up db-down migrate typecheck test demo demo-m0 demo-m1 demo-m2 demo-m3 demo-m4 demo-m5 demo-slack-app slack-app smoke-pi smoke-github smoke-github-write smoke-slack down

install:
	pnpm install

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

demo-slack-app: db-up migrate
	pnpm --filter @marathon/demo-slack-app start

# Run the LIVE Slack app (long-running; needs Slack + model keys in .env).
slack-app: db-up migrate
	set -a; . ./.env; set +a; pnpm --filter @marathon/demo-slack-app live

# Local-only smokes against real services (need keys/tokens). Not run in CI.
smoke-pi:
	pnpm --filter @marathon/demo-m2 smoke

smoke-github:
	pnpm --filter @marathon/demo-m3 smoke

smoke-github-write:
	pnpm --filter @marathon/demo-m5 smoke

smoke-slack:
	pnpm --filter @marathon/demo-m4 smoke

# Runs the full demo chain (grows as milestones land).
demo: demo-m0 demo-m1 demo-m2 demo-m3 demo-m4 demo-m5

down: db-down
