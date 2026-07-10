# Installing Marathon — agent playbook

This document is written for an **agent** performing the install, not a human
skimming it — follow it step by step, in order. For human-oriented background
(architecture, account-creation screenshots-in-prose, timing) see
[`docs/quickstart.md`](./docs/quickstart.md) and [`PREREQUISITES.md`](./PREREQUISITES.md);
this file only sequences the actions.

## 0. Check the local environment

Confirm before proceeding (stop and tell the user what's missing, don't guess):

- Node >= 22, pnpm 10 installed.
- Docker + Docker Compose available (Postgres, and the BUILD sandbox for code tasks).
- This is a clone of `thgibbs/marathon` (or a fork of it).

## 1. Collect from the user

Ask for the following. State the minimum path up front so the user isn't
blocked on things they can defer:

> **Minimum to get one agent loop running:** a target GitHub repo, one model
> provider API key, and one GitHub credential. Everything else below (Slack,
> GitHub App webhooks, trust-profile knobs) can be deferred.

- **Target repo** — the ONE GitHub repo (`owner/name`) Marathon will operate
  against. Required — every GitHub/document tool grant is scoped to it by
  construction.
- **Model provider + API key** — at least one of: Anthropic (`ANTHROPIC_API_KEY`),
  OpenAI (`OPENAI_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`). Ask which
  provider(s) they already have billing + a spend cap on.
- **GitHub credential** — either:
  - a fine-grained personal access token with Contents + Pull requests
    read/write on the target repo → `GITHUB_TOKEN` (quickstart path), or
  - a GitHub App → `GITHUB_APP_ID`, and either `GITHUB_APP_PRIVATE_KEY_PATH`
    (path to the downloaded `.pem`) or `GITHUB_APP_PRIVATE_KEY` (inline PEM).
- **Deployment tenant name** — `MARATHON_TENANT`, one name binding the Slack
  and GitHub surfaces to the same deployment. Ask for something short and
  stable (e.g. their org name); skip only for an isolated demo/test run.
- **Secret store master key** — `MARATHON_SECRET_KEY`. If the user has no
  preference, generate a strong random value yourself — do not ask them to
  invent one, and never print it back in chat.
- **Database port** — only if 5432 is already taken locally → `MARATHON_DB_PORT`.
- **Sandbox network posture** — `MARATHON_SANDBOX_NETWORK`. Default is
  `bridge` (internet, needed for installs); ask only if they explicitly want
  the stricter `none`.

Ask only if the user wants the Slack surface running now:

- **Slack app credentials** — `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN` (see §4 of `docs/quickstart.md` for how they create these).

Ask only if the user wants the GitHub App / webhook surface (draft-doc-PR-from-mention,
revise-from-comment, i.e. `make github-app`) running now:

- **GitHub owner** — `GITHUB_OWNER`, the account/org that owns the target
  repo. Scoped to the GitHub document/webhook app in `.env.example`; the
  PAT-only quickstart path does not need it, since the owner is already
  embedded in the target repo's `owner/name`.
- **Webhook secret** — `GITHUB_WEBHOOK_SECRET`.
- **Webhook delivery** — a smee.io channel URL → `MARATHON_WEBHOOK_PROXY`, or a
  public tunnel URL if they'd rather point the GitHub App at that directly.
- If using GitHub App identity linking: `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET`, `MARATHON_LINK_BASE_URL`.

## 2. Fill in the files

1. `cp .env.example .env` if `.env` doesn't already exist.
2. Write every collected value into `.env` under its variable name (names are
   verbatim from `.env.example`). Leave anything not collected blank.
3. Set `repo:` in `agents/forge.yaml` to the target repo — this is the one
   field the flagship agent requires; the live apps refuse to boot without it.
4. If the user picked a non-default model provider, edit `models.default`
   (and optionally `models.build`) in the same YAML to `provider:model`,
   matching the key filled into `.env`.
5. `.marathon/config.yml` must exist **in the target repo** (not in this
   Marathon clone) before the first BUILD task runs — it holds the `verify:`
   commands Marathon uses to check its own work, and BUILD reads it from the
   target repo's default branch, not from anything committed here. Marathon
   does not generate or commit this file for you; the user (or you, acting on
   their behalf, using the GitHub credential collected in step 1) must add
   it:
   - Check whether the target repo already has `.marathon/config.yml` on its
     default branch. If so, skip the rest of this step.
   - If not, clone (or open) the target repo separately from this Marathon
     checkout, add `.marathon/config.yml` with `verify:` commands that match
     what that repo actually runs (e.g. `pnpm test`, `pnpm typecheck`), and
     commit it directly to the default branch (or open and merge a small PR)
     using the collected GitHub credential — before queuing any BUILD task
     against that repo.
6. Never print `.env` contents back to the user or commit them — `.env` is
   gitignored; secrets live only there or in the secret store.

## 3. Boot and verify

```bash
pnpm install
make hooks                 # points git's core.hooksPath at the repo's pre-commit hook, once
make demo-kernel           # proves the K1-K5 loop offline with fakes/fixtures
```

`make hooks` only wires up the hooks path — the pre-commit hook itself runs a
gitleaks secret scan *if gitleaks is installed*, and succeeds as a silent
no-op if it isn't. Install gitleaks separately
(https://github.com/gitleaks/gitleaks#installing) if you want scanning to
actually happen, then confirm it's wired up with a throwaway commit (or
`make secret-scan`, if the target repo defines that target) — otherwise treat
the hook as best-effort until gitleaks is present.

If port 5432 was taken: `make demo-kernel MARATHON_DB_PORT=<port>` and mirror
that port in `DATABASE_URL` in `.env`.

For code tasks, build the sandbox toolchain image once:

```bash
make sandbox-image
```

Then, depending on which credentials were collected in step 1:

- Model key + GitHub credential only → the loop is proven by the demos above;
  nothing live to run yet.
- + Slack credentials → `make slack-app`, then in the target workspace invite
  the bot to a channel and `@marathon <ask>`.
- + GitHub App + webhook delivery → `make github-app` (webhook receiver + the
  BUILD worker together).

## 4. Report back to the user

Print:

- Which `.env` variables were filled vs. left blank (names only, never values).
- The exact command(s) to run next, from step 3, based on what's configured.
- A pointer to `PREREQUISITES.md` for anything not available yet (e.g. an
  account/key that still needs to be created) and `docs/quickstart.md` for the
  full human-oriented walkthrough.
