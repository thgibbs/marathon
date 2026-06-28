SHELL := /bin/bash
DATABASE_URL ?= postgres://marathon:marathon@localhost:5432/marathon
export DATABASE_URL

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
