# Marathon Quickstart

Goal (roadmap **K6**): `git clone → docker compose up → YAML agent → Slack app +
GitHub App → first loop` on your own repo, in under ~30 minutes.

The loop you are setting up (design §0.1):

```text
Slack ask -> design-doc PR -> iterate -> merge-as-approval -> sandboxed code work ->
green-tested code PR -> deliver links back to Slack and the doc PR
```

> **Status.** Track 14 lands the configuration surface (YAML agents, credential
> layout, this walkthrough). The single `make demo-kernel` umbrella and the timed
> stranger test close later in K6 — until then, the loop is proven piecewise by
> `make demo-slack-app`, `make demo-github-app`, `make demo-k1-brokered`, and
> `make demo-k4`/`smoke-k4`.

## 0. Prerequisites

- Node ≥ 22, pnpm, Docker (compose).
- A GitHub repo you can install an App on (your target repo).
- A Slack workspace where you can create an app.
- One model provider API key (OpenAI or Anthropic), with billing + a spend cap.

Account-level details (creating keys, billing caps) live in
[`PREREQUISITES.md`](../PREREQUISITES.md).

## 1. Clone, install, boot

```bash
git clone https://github.com/<you>/marathon && cd marathon
pnpm install
cp .env.example .env          # fill in as you go below
make demo-slack-app           # boots Postgres, migrates, proves the Slack loop offline
```

If host port 5432 is taken: `make demo-slack-app MARATHON_DB_PORT=55432` (and
adjust `DATABASE_URL`).

## 2. Define your agent (YAML)

Agents are YAML files in `agents/` (override with `MARATHON_AGENTS_DIR`); the
first file alphabetically is the deployment's default agent. Start from the
flagship, [`agents/forge.yaml`](../agents/forge.yaml), and set the one thing it
needs — your target repo:

```yaml
repo: your-org/your-repo
```

The full config shape (design §6.2 / §21.0):

| Field | What it does |
|---|---|
| `name`, `display_name`, `description` | identity; instructions publish through an `AgentVersion` |
| `instructions` | the persona — how the agent runs the loop |
| `harness` | `pi` (default) — `claude-code` arrives with K7 |
| `repo` | the ONE target repo; scopes every GitHub grant by construction |
| `tools` | grants, incl. brokered command families (`github.exec: pr view, pr create, …`; `git.exec: push, fetch`) |
| `sandbox.network` | BUILD container network: `bridge` (internet, default) or `none` |
| `models` | role → `provider:model` routing (`default`, `reasoning`, `cheap`) |
| `budget` | hard spend cap in USD (`limit_usd`, fails closed) + `warn_ratio` |

Config is deliberately restart-applied: edit the YAML, restart the app, and the
new instructions publish as the next agent version.

## 3. GitHub credentials (the broker model)

Marathon does not hand the model a GitHub token. The credential layout
(design §12, Tracks 6–9):

- **Reads** — direct API tools (`github.read_file`, …) or brokered
  (`github.exec` read families like `pr view`, `pr diff`, read-only `gh api`).
  Either way the token is injected host-side.
- **Writes** — always brokered: `git.exec push` and `github.exec pr create/edit`
  run on the host with the token in the child process env only. The BUILD
  sandbox itself is **credential-free** (internet access, no secrets).
- **Destructive actions** — never direct. Merging a PR is either a human's
  native review (merge the PR yourself — that *is* the approval) or a
  **Proposed Effect** the model proposes and a non-model executor performs
  after human approval. GitHub's own controls (branch protection, rulesets,
  CODEOWNERS, secret scanning, CI) stay the enforcement layer.

Setup:

1. Create a fine-grained token (or GitHub App) with Contents + Pull requests
   read/write on your target repo → `GITHUB_TOKEN` in `.env`.
2. Protect your default branch (Marathon only pushes `marathon/*` branches;
   branch protection makes that structural).
3. For the document surface webhooks: create a GitHub App, subscribe to
   `issue_comment`, `pull_request_review_comment`, and `pull_request`, point it
   at your tunnel + `GITHUB_WEBHOOK_SECRET`, and install it on the repo. Then
   `make github-app` (needs `GITHUB_OWNER`, a tunnel like ngrok in dev).

## 4. Slack app

1. Create a Slack app (from scratch) at api.slack.com/apps in your workspace.
2. **Socket Mode**: enable it; create an app-level token with
   `connections:write` → `SLACK_APP_TOKEN` (xapp-).
3. **OAuth scopes** (Bot Token): `app_mentions:read`, `chat:write`,
   `channels:history`, `reactions:read`. Install to workspace →
   `SLACK_BOT_TOKEN` (xoxb-), and copy the signing secret →
   `SLACK_SIGNING_SECRET`.
4. Subscribe to bot events: `app_mention`, `message.channels`,
   `reaction_added`.
5. Run the listener: `make slack-app`, invite the bot to a channel, and
   `@marathon <ask>`. The default agent (your first YAML file) answers in a
   thread; replies to its clarifying questions resume the same durable task.

## 5. Sandbox toolchain (code tasks)

BUILD-stage work runs in a pinned, credential-free Docker image with git, gh
(public reads only), Node 22 + pnpm, and build tools:

```bash
make sandbox-image        # builds marathon-sandbox:kernel from docker/sandbox/Dockerfile
make smoke-sandbox        # proves the open (bridge) default and the strict (none) mode
```

Network default is internet-enabled (`bridge`) for installs/docs — override per
deployment with `MARATHON_SANDBOX_NETWORK=none` or per agent with
`sandbox.network` in the YAML. No env vars or secrets ever enter the container.

## 6. Tell Marathon how to verify your repo

Add `.marathon/config.yml` to the **target** repo (design §29.3):

```yaml
verify:
  - pnpm typecheck
  - pnpm test
```

Discovery precedence: this file → the plan doc's own Verification section → the
agent's judgment. A red verify at the budget cap becomes an honest **draft PR**
with a failure summary, never a claimed-green one.

## 7. Prove the loop

```bash
make demo-slack-app      # ask -> durable clarifying question -> resume -> answer
make demo-github-app     # mention -> doc PR -> revise -> merge spawns implementation task
make demo-k1-brokered    # YAML grants -> brokered git push / gh pr create -> delivery.report_pr
make demo-k4             # mid-BUILD kill -> resume -> exactly one PR
```

All demos are deterministic (fakes/fixtures); the `smoke-*` targets run the
same seams against real services with your `.env` keys.
