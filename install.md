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
- Never invent a secret value. The one exception is `MARATHON_SECRET_KEY` (and,
  for a PAT-based GitHub install, `GITHUB_WEBHOOK_SECRET` — see §1.8): if the
  human doesn't supply one, generate a random 32+ byte value yourself
  (e.g. `openssl rand -hex 32`) rather than asking them to hand-pick one.
- Never print a collected secret value back into chat, logs, or a PR/commit.
  `.env` is git-ignored — verify that before writing to it.
- Only write the *credential/secret* fields the human actually provided
  (Groups A–C); leave every other secret key blank in `.env` rather than
  guessing. Group D (§1.12–14) is different: those keys already ship
  pre-filled with sane defaults in `.env.example`, so leave them exactly as
  the template wrote them unless the human explicitly asks for a non-default
  value — don't blank them out, and don't assume the app will silently
  default an unset Group D key at runtime; the default is whatever value is
  already sitting in `.env.example`/`agents/forge.yaml`.
- `MARATHON_TENANT` (§1.4) and `GITHUB_OWNER` (§1.9, if Group C applies) are
  required *config* values, not secrets — always write them into `.env`
  (§2.3) regardless of which credential groups the human opts into. Don't
  lump them in with the "leave blank if not provided" guidance above.
- Don't start long-running processes yourself (`make slack-app` and `make
  github-app` block forever). Run commands that exit (`pnpm install`, `make
  demo-slack-app`, `make sandbox-image`, …), then hand the long-running
  commands to the human as printed instructions (§5). `make
  register-github-app` (§1.8) is the one interactive exception: it blocks
  only until the human finishes a single browser confirmation, then exits —
  running it yourself is fine.
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

These three values don't exist until a Slack app has been created,
configured, and installed to the workspace — that has to happen *before*
you can collect them, not after `make slack-app` (§5 only runs the
already-configured app; it doesn't create one). Every deployment creates
its **own** app (Socket Mode tokens are app-global, and Slack splits event
delivery across all connected instances — a shared app silently loses
events to the other deployment). Walk the human through the manifest flow
first; it pre-configures Socket Mode, all bot scopes, the event
subscriptions, and the `/marathon` slash command in one paste:

- Create the app at [api.slack.com/apps](https://api.slack.com/apps) →
  "Create New App" → **"From a manifest"** → pick the workspace → paste the
  contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml) (repo
  root).
- Basic Information → App-Level Tokens → generate a token with scope
  `connections:write` — the token needed for item 7 below (the manifest
  enables Socket Mode but cannot mint this token).
- Install App → "Install to Workspace" — produces the Bot User OAuth Token
  needed for item 5.
- Basic Information → App Credentials → the Signing Secret needed for
  item 6.

5. `SLACK_BOT_TOKEN` (xoxb-) — the Bot User OAuth Token from installing the
   app above (the manifest already granted the needed scopes:
   `app_mentions:read`, `chat:write`, `channels:history`, `reactions:read`,
   `reactions:write`).
6. `SLACK_SIGNING_SECRET` — from Basic Information → App Credentials.
7. `SLACK_APP_TOKEN` (xapp-) — the Socket Mode app-level token, scope
   `connections:write`.

### Group C — GitHub document surface (only if running `make github-app`)
8. GitHub credential **and** webhook — pick one path; both need a webhook
   because the running app is driven entirely by inbound GitHub events, there
   is no polling fallback:
   - **PAT path (quickstart)** — a fine-grained PAT with Contents + Pull
     requests read/write on the target repo → `GITHUB_TOKEN`. A PAT has no
     webhook of its own, so you must create one by hand: on the target repo,
     go to Settings → Webhooks → Add webhook, content type
     `application/json`, subscribed to the same events listed below, pointed
     at the URL from §1.10. Generate the shared secret yourself the same way
     as `MARATHON_SECRET_KEY` (`openssl rand -hex 32`), paste it into that
     webhook's "Secret" field on GitHub, and set the identical value as
     `GITHUB_WEBHOOK_SECRET` in `.env`.
   - **GitHub App path (preferred)** — one command registers a private,
     per-deployment App from a manifest and writes everything into `.env`:
     ```bash
     make register-github-app
     ```
     It creates a dev smee channel, then serves a local page (default
     `http://localhost:8895`) — have the human open it, click "Register
     GitHub App", and confirm on github.com (the app name is editable
     there). On the redirect back it writes `GITHUB_APP_ID`,
     `GITHUB_APP_PRIVATE_KEY_PATH` (key saved under the git-ignored
     `.keys/`), `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`,
     `GITHUB_APP_CLIENT_SECRET`, and `MARATHON_WEBHOOK_PROXY` into `.env`
     itself — that's items 8 and 10 and the client-credentials half of
     item 11 done in one step; do NOT re-ask the human for any of them.
     Variants: production endpoint instead of smee →
     `pnpm --filter @marathon/setup register-github-app -- --webhook-url
     https://<host>/webhooks/github`; org-owned app → append `-- --org <org>`.
     Every deployment registers its own App — a shared App's private key can
     mint tokens for *every* installation of that App, and its single
     webhook URL delivers everyone's events to one endpoint.

     Registering does not by itself grant repo access — the command prints
     an install link (`https://github.com/apps/<slug>/installations/new`);
     the human must open it, choose the account that owns the target repo,
     and select that repo (avoid "All repositories" — it needlessly widens
     what the credential can touch). Skipping this step leaves the App with
     valid credentials but no access, and every API call will 404/403.

     Manual fallback (no browser on this host): register the App by hand
     with repository permissions Contents (R/W), Pull requests (R/W),
     Issues (R/W), Metadata (R); subscribe to `issue_comment`,
     `pull_request_review_comment`, `pull_request_review`, `pull_request`;
     set the webhook URL from §1.10 and its secret on the App's own webhook
     config screen and copy that secret into `GITHUB_WEBHOOK_SECRET`; then
     collect `GITHUB_APP_ID` and the private key as either
     `GITHUB_APP_PRIVATE_KEY_PATH` (path to the downloaded `.pem`) or
     `GITHUB_APP_PRIVATE_KEY` (PEM contents inline).

   Either path, `GITHUB_WEBHOOK_SECRET` is required in `.env` — the running
   app verifies every inbound webhook payload's signature against it.
9. `GITHUB_OWNER` — the repo owner for this tenant.
10. Webhook delivery target — `make register-github-app` already handled
    this for the App path (channel created, baked into the App's webhook
    config, and written to `MARATHON_WEBHOOK_PROXY`); collect it manually
    only for the PAT path or the manual-App fallback. Pick one, and register
    it as the webhook URL on whichever side owns the webhook (the repo
    webhook you created by hand for the PAT path, or the GitHub App's
    webhook config for the App path):
    - **Dev**: create a channel at [smee.io/new](https://smee.io/new) →
      `MARATHON_WEBHOOK_PROXY`. No forwarding client is needed: with this
      set, `make github-app` itself subscribes outbound to the channel and
      feeds each relayed delivery through the same signature-verified
      receiver (see `MARATHON_WEBHOOK_PROXY` in `.env.example`).
    - **Production**: a public tunnel/load-balancer URL that already points
      at `/webhooks/github` on this host — leave `MARATHON_WEBHOOK_PROXY`
      unset in that case.
11. `MARATHON_LINK_BASE_URL` — only if enabling `/marathon link github`
    identity linking; otherwise skip. (`GITHUB_APP_CLIENT_ID` /
    `GITHUB_APP_CLIENT_SECRET`, the other half of identity linking, were
    already written by `make register-github-app`; collect them manually
    only on the manual-App fallback.)

### Group D — environment tuning (optional; already defaulted in the shipped template — ask only if the human wants something different)
12. `MARATHON_DB_PORT` — only if local port 5432 is already taken.
13. `MARATHON_TRUST_PROFILE` (`solo` | `team` | `org` | `hosted`) — ships as
    `solo` in `.env.example`; that's the default a clean install gets with no
    action from you. Only touch this key if the human already knows they want
    something else.
14. `MARATHON_SANDBOX_NETWORK` (`bridge` | `none`) — ships as `bridge` in
    `.env.example` (internet-enabled BUILD sandbox); that's the default a
    clean install gets with no action from you. Only set `none` if the human
    asks for the strict, no-egress posture.

## 2. Fill out `.env`

1. If `.env` does not exist yet, copy it from the template:
   ```bash
   cp .env.example .env
   ```
2. Confirm `.env` is git-ignored (`git check-ignore .env`) before writing
   any secret into it.
3. Edit `.env`, writing in:
   - `MARATHON_TENANT` (§1.4) — required for every install.
   - `GITHUB_OWNER` (§1.9) — required if Group C was collected.
   - the credential/secret keys the human actually provided from Groups
     A–C.
   Leave every other *secret* key blank — do not delete keys, just don't
   fill them in. Group D keys (`MARATHON_TRUST_PROFILE`,
   `MARATHON_SANDBOX_NETWORK`) already arrive pre-filled with their defaults
   from `.env.example` in step 1 — leave those values exactly as-is unless
   the human explicitly asked for a non-default value (§1.13–14).
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
  The Slack app itself was already created, configured, and installed to
  the workspace while collecting Group B (§1.5–7). Once `make slack-app` is
  running: invite the bot to a channel and `@marathon <ask>` in that
  channel.

- If Group C (GitHub) was configured:
  ```bash
  make github-app
  ```
  Webhook delivery has to be live before events will arrive:
  - **Dev**: nothing extra to run — with `MARATHON_WEBHOOK_PROXY` set in
    `.env` (written by `make register-github-app`, or by hand in §1.10),
    `make github-app` itself subscribes outbound to the smee channel; its
    boot log says which mode it's in.
  - **Production**: confirm the tunnel/load-balancer from §1.10 is live and
    still pointed at `/webhooks/github`.
  The webhook URL itself was already registered in §1.8 — by
  `make register-github-app` (App path) or on the repo webhook you created
  by hand (PAT path). Once delivery is live, mention/comment on a PR in
  the target repo to trigger the loop.

- To stop the local database:
  ```bash
  make down
  ```

- Point the human at [`docs/quickstart.md`](docs/quickstart.md) for the full
  narrative walkthrough and troubleshooting notes, and at
  [`PREREQUISITES.md`](PREREQUISITES.md) for account-level setup (billing
  caps, branch protection, etc.) not covered here.
