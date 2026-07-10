# Installing Marathon (agent guide)

This file is written for an **agent** (not a human reader) to drive a Marathon
install end-to-end: collect the information listed in §1 from the human it is
working with, write that information into `.env` and `agents/forge.yaml` (§2–3),
run the setup commands (§4), and finish by printing the run instructions in §5.
It complements — but does not replace — the prose walkthrough in
[`docs/quickstart.md`](docs/quickstart.md) and the account-level checklist in
[`PREREQUISITES.md`](PREREQUISITES.md); consult those for *why* a step exists.

## 0. Ground rules for the installing agent

- Ask for secrets one group at a time (§1), not all 14 items at once — skip a
  group entirely if the human says they don't need that surface yet (e.g. no
  Slack app, no GitHub App).
- Never invent a secret value. The one exception is `MARATHON_SECRET_KEY`: if
  the human doesn't supply one, generate a random 32+ byte value yourself
  (e.g. `openssl rand -hex 32`) rather than asking them to hand-pick one.
- Never print a collected secret value back into chat, logs, or a PR/commit.
  `.env` is git-ignored — verify that before writing to it.
- Only write the fields the human actually provided; leave the rest blank in
  `.env` rather than guessing.
- Don't start long-running processes yourself (`make slack-app`, `make
  github-app` block forever). Run verification commands that exit
  (`pnpm install`, `make demo-slack-app`, `make sandbox-image`, …), then hand
  the long-running commands to the human as printed instructions (§5).
- If a command fails, report the exit code and output verbatim — don't paper
  over a failure.

## 1. Information to collect from the human

### Group A — required for any install
1. Confirm locally (don't ask the human): Node >= 22, pnpm 10, Docker +
   Docker Compose available on `PATH`.
2. Target GitHub repo this deployment will operate on, as `owner/name` — goes
   into `agents/forge.yaml` `repo:`. Every GitHub/document grant is scoped to
   this one repo by construction; the live apps refuse to boot without it.
3. At least one model provider API key:
   - Anthropic → `ANTHROPIC_API_KEY`
   - OpenAI → `OPENAI_API_KEY`
   - OpenRouter → `OPENROUTER_API_KEY`
4. `MARATHON_TENANT` — one short name for this deployment (e.g. an org or
   team slug). Both live apps bind their surface to this one tenant so a doc
   PR drafted from Slack is the same artifact the GitHub app later revises.

### Group B — Slack surface (only if running `make slack-app`)
5. `SLACK_BOT_TOKEN` (xoxb-) — Bot Token OAuth scopes needed:
   `app_mentions:read`, `chat:write`, `channels:history`, `reactions:read`,
   `reactions:write`.
6. `SLACK_SIGNING_SECRET`.
7. `SLACK_APP_TOKEN` (xapp-) — Socket Mode app-level token with
   `connections:write`.

### Group C — GitHub document surface (only if running `make github-app`)
8. GitHub credential, either:
   - a fine-grained PAT with Contents + Pull requests read/write on the target
     repo → `GITHUB_TOKEN` (quickstart path), or
   - a GitHub App → `GITHUB_APP_ID` and its private key as either
     `GITHUB_APP_PRIVATE_KEY_PATH` (path to the downloaded `.pem`) or
     `GITHUB_APP_PRIVATE_KEY` (PEM contents inline), plus
     `GITHUB_WEBHOOK_SECRET`. Repository permissions: Contents (R/W), Pull
     requests (R/W), Issues (R/W), Metadata (R). Subscribe to
     `issue_comment`, `pull_request_review_comment`, `pull_request_review`,
     `pull_request`.
9. `GITHUB_OWNER` — the repo owner for this tenant.
10. Webhook delivery target: a [smee.io](https://smee.io/new) channel URL for
    dev → `MARATHON_WEBHOOK_PROXY`, or a public tunnel URL pointed at
    `/webhooks/github` for production (leave `MARATHON_WEBHOOK_PROXY` unset in
    that case).
11. `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` and
    `MARATHON_LINK_BASE_URL` — only if enabling `/marathon link github`
    identity linking; otherwise skip.

### Group D — environment tuning (optional; use defaults unless asked)
12. `MARATHON_DB_PORT` — only if local port 5432 is already taken.
13. `MARATHON_TRUST_PROFILE` (`solo` | `team` | `org` | `hosted`) — defaults
    to `solo`; ask only if the human already knows they want something else.
14. `MARATHON_SANDBOX_NETWORK` (`bridge` | `none`) — defaults to `bridge`
    (internet-enabled BUILD sandbox); set `none` only for the strict,
    no-egress posture.

## 2. Fill out `.env`

1. If `.env` does not exist yet, copy it from the template:
   ```bash
   cp .env.example .env
   ```
2. Confirm `.env` is git-ignored (`git check-ignore .env`) before writing
   any secret into it.
3. Edit `.env`, setting exactly the keys the human provided from §1. Leave
   every other key blank — do not delete keys, just don't fill them in.
4. If `MARATHON_DB_PORT` was customized, also update `DATABASE_URL` in
   `.env` to match:
   ```
   DATABASE_URL=postgres://marathon:marathon@localhost:<PORT>/marathon
   ```
5. If `MARATHON_SECRET_KEY` wasn't provided, generate one and write it in:
   ```bash
   openssl rand -hex 32
   ```

## 3. Fill out the agent config (`agents/forge.yaml`)

1. Set the required field from §1.2:
   ```yaml
   repo: <owner>/<name>
   ```
2. If the human's model key is not OpenAI (the shipped default), update
   `models.default` (and optionally `models.build`) to match the provider
   they gave a key for, e.g.:
   ```yaml
   models:
     default: anthropic:claude-sonnet-4-6
   ```
3. Leave `tools`, `sandbox`, and `budget` at their shipped values unless the
   human explicitly asks to change them (e.g. a tighter `budget.limit_usd`,
   or `sandbox.network: none` for the strict posture).

## 4. Run install + verify commands

Run these in order; each should exit 0 before moving to the next. Surface any
non-zero exit verbatim rather than continuing.

```bash
pnpm install
make hooks               # enables the gitleaks pre-commit secret scan
make demo-slack-app      # boots Postgres, migrates, proves the Slack loop offline
```

If port 5432 was already taken and `MARATHON_DB_PORT` was set in §2:

```bash
make demo-slack-app MARATHON_DB_PORT=<PORT>
```

If Group C (GitHub) info was collected, also run:

```bash
make demo-github-app
```

If code tasks (BUILD sandbox) will be used:

```bash
make sandbox-image       # builds marathon-sandbox:kernel
make demo-k1-network     # proves internet + no-secrets in the sandbox (needs Docker)
```

To run the full kernel regression umbrella:

```bash
make demo-kernel
pnpm test && pnpm typecheck
```

Also remind the human to add `.marathon/config.yml` to the **target** repo
(not this one) so Marathon knows how to verify it, e.g.:

```yaml
verify:
  - pnpm typecheck
  - pnpm test
```

## 5. Print run instructions

Once §4 passes, print instructions tailored to what was configured — don't
run these yourself, they're long-lived:

- If Group B (Slack) was configured:
  ```bash
  make slack-app
  ```
  Then: create the Slack app at api.slack.com/apps, enable Socket Mode,
  install it to the workspace, invite the bot to a channel, and
  `@marathon <ask>` in that channel.

- If Group C (GitHub) was configured:
  ```bash
  make github-app
  ```
  Point the GitHub App's webhook URL (or the smee channel from §1.10) at this
  host, then mention/comment on a PR in the target repo to trigger the loop.

- To stop the local database:
  ```bash
  make down
  ```

- Point the human at [`docs/quickstart.md`](docs/quickstart.md) for the full
  narrative walkthrough and troubleshooting notes, and at
  [`PREREQUISITES.md`](PREREQUISITES.md) for account-level setup (billing
  caps, branch protection, etc.) not covered here.
