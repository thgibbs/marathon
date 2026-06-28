SHELL := /bin/bash
# Host port for the dockerized Postgres. Override if 5432 is taken locally,
# e.g. `make demo-m0 MARATHON_DB_PORT=55432`.
MARATHON_DB_PORT ?= 5432
DATABASE_URL ?= postgres://marathon:marathon@localhost:$(MARATHON_DB_PORT)/marathon
export DATABASE_URL MARATHON_DB_PORT

.PHONY: install db-up db-down migrate typecheck test demo demo-m0 down

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

# Runs the full demo chain (grows as milestones land).
demo: demo-m0

down: db-down
