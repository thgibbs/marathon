# Marathon Quickstart

Goal (roadmap **K6**): `git clone → docker compose up → YAML agent → Slack app +
GitHub App → first loop` on your own repo, in under ~30 minutes.

The loop you are setting up (design §0.1):

```text
Slack ask -> design-doc PR (against the plans branch) -> iterate ->
merge-as-approval (into the plans branch; main untouched) -> sandboxed code work ->
verified code PR carrying code + plan -> deliver links back to Slack and the doc PR
```

> **Status.** The migration tracks (1–18) have all landed: the loop is proven
> end-to-end by **`make demo-kernel`** (the K1–K5 umbrella: brokered delivery,
> sandbox network reality, fan-out, iteration continuity, kill/resume,
> status + cost). The remaining K6 item is the timed stranger test — this
> walkthrough completing on a fresh machine in under ~30 minutes.

## 0. Prerequisites

- Node >= 22, pnpm 10, Docker Compose for Postgres, and Docker for sandbox/code tasks.
- A GitHub repo you can install an App on (your target repo).
- A Slack workspace where you can create an app.
- One model provider API key (OpenAI or Anthropic), with billing + a spend cap.

Account-level details (creating keys, billing caps) live in
[`PREREQUISITES.md`](../PREREQUISITES.md).

## 1. Clone, install, boot

```bash
git clone https://github.com/thgibbs/marathon.git
cd marathon
pnpm install
cp .env.example .env          # fill in as you go below
make demo-slack-app           # boots Postgres, migrates, proves the Slack loop offline
```

If host port 5432 is taken, use one port everywhere:

```bash
make demo-slack-app MARATHON_DB_PORT=55432
```

Set `DATABASE_URL=postgres://marathon:marathon@localhost:55432/marathon` in `.env`
for live app runs on that port.

Also set `MARATHON_TENANT` in `.env` to one name for your deployment (e.g. your
org). The Slack and GitHub apps each bind their surface to this ONE tenant, so
the loop stays connected across surfaces — a doc PR drafted from a Slack ask is
the same artifact the GitHub app revises when someone comments on it. Without
it, each surface bootstraps an isolated tenant and cross-surface lookups miss.

> **Upgrading an install that predates `MARATHON_TENANT`?** Your DB already
> has one tenant per surface, and existing surface bindings deliberately win
> over the deployment name — setting the variable does NOT merge them. Either
> reset dev data (`docker compose down -v`, then re-run the boot steps) or do
> a one-time merge before restarting: pick a survivor tenant, move the other
> tenant's binding onto it, stamp the deployment marker, and re-point rows —
>
> ```sql
> -- keep <SURVIVOR>, retire <OLD> (bindings are unique: remove before adding)
> update tenant set settings = settings - 'github_owner' where id = '<OLD>';
> update tenant set settings = settings
>   || jsonb_build_object('github_owner', '<owner>', 'deployment', '<MARATHON_TENANT>')
>   where id = '<SURVIVOR>';
> update document_artifact set tenant_id = '<SURVIVOR>' where tenant_id = '<OLD>';
> update code_change set tenant_id = '<SURVIVOR>' where tenant_id = '<OLD>';
> ```
>
> (Swap the binding key if your survivor is the GitHub-bound tenant. The
> artifact/code-change re-point is what lets the revision loop find PRs
> drafted before the merge.)

## 2. Define your agent (YAML)

Agents are YAML files in `agents/` (override with `MARATHON_AGENTS_DIR`); files
are loaded alphabetically, and the first file is the deployment's default agent. Start
from the flagship, [`agents/forge.yaml`](../agents/forge.yaml), and set the one thing
it needs — your target repo:

```yaml
repo: your-org/your-repo
```

This is required, not optional: the live apps refuse to boot while GitHub or
document tools are granted without a `repo`, because every grant is scoped to
the ONE configured repo by construction.

The default Forge spec uses OpenAI model refs. If you want another provider, edit
`models.default` before starting the live apps, optionally add `models.build` for a
different BUILD-stage model, and put that provider's API key in `.env`.

The full config shape (design §6.2 / §21.0):

| Field | What it does |
|---|---|
| `name`, `display_name`, `description` | identity; instructions publish through an `AgentVersion` |
| `instructions` | the persona — how the agent runs the loop |
| `harness` | `pi` (default) — `claude-code` arrives with K7 |
| `repo` | the ONE target repo; scopes every GitHub grant by construction |
| `tools` | grants, incl. brokered command families (`github.exec: pr view, pr create, …`; `git.exec: push, fetch`) |
| `plans.branch` | where design-doc PRs merge — the approval (§29.1a); default `marathon-plans`, refused if under `marathon/*` (the agent push namespace); the plan doc reaches main only WITH its implementation's code PR |
| `sandbox.network` | BUILD container network: `bridge` (internet, default) or `none` — `none` from the YAML, `MARATHON_SANDBOX_NETWORK`, or code wins (strictness composes) |
| `models` | role → `provider:model` routing (`default`, `reasoning`, `cheap`; a `build` role routes the BUILD stage) |
| `budget` | hard spend cap in USD (`limit_usd`, fails closed) + `warn_ratio` — enforced per agent AND per task, at every turn boundary |

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

1. Create a fine-grained token with Contents + Pull requests read/write on your
   target repo → `GITHUB_TOKEN` in `.env`. For production, use the GitHub App
   fields in `.env.example`; the broker model is the same.
2. Protect your default branch (Marathon only pushes `marathon/*` branches;
   branch protection makes that structural).
3. **Protect the plans branch too** (`marathon-plans` by default — created at
   boot when missing). It is an approval boundary (§29.1a): design-doc PRs
   merge into it, and that merge is what triggers implementation — so it must
   accept changes only via reviewed PRs, never direct pushes. It deliberately
   sits outside `marathon/*` so rulesets that open that prefix to agent pushes
   don't open the approval boundary. An abandoned plan just stays there; an
   implemented plan reaches main with its code PR.
4. For the document surface webhooks: create a GitHub App, subscribe to
   `issue_comment`, `pull_request_review_comment`, `pull_request_review`, and
   `pull_request`, set a
   webhook secret → `GITHUB_WEBHOOK_SECRET`, and install it on the repo. For
   the webhook URL, create a channel at [smee.io/new](https://smee.io/new) and
   use it — no tunnel needed, and the URL is set once (the channel is stable
   across restarts).
5. Set `GITHUB_OWNER` to the repository owner used for this Marathon tenant
   and `MARATHON_WEBHOOK_PROXY` to the same smee channel URL, then run
   `make github-app` — it subscribes outbound to the channel and feeds each
   delivery through the same signature-verified receiver. (Production shape:
   leave `MARATHON_WEBHOOK_PROXY` unset and point the App's webhook URL at a
   public URL/tunnel to this host's `/webhooks/github`.)

`make github-app` runs both halves of the GitHub side: the webhook receiver
(mention → doc PR, comment → revision, merge → implementation task) **and the
BUILD worker** that consumes those implementation/revision tasks — Pi in the
credential-free sandbox (network mode from the agent YAML), brokered
`gh`/`git`, `delivery.report_pr`, model + budget from the same YAML. Workers on
a shared queue partition by job kind, so the BUILD worker and the Slack app's
general worker never take each other's work.

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
   thread; replies to its clarifying questions resume the same durable task,
   and a reply after it finishes chains a follow-up task in the same thread.
   `@marathon status` in a task's thread reports the §15.3 view — what it's
   doing now, completed steps, what it's waiting on, the delivered PR link,
   and cost so far; final results carry a silent cost footer (§13.3).

## 5. Sandbox toolchain (code tasks)

BUILD-stage work runs in a pinned, credential-free Docker image with git, gh
(public reads only), Node 22 + pnpm, and build tools:

```bash
make sandbox-image        # builds marathon-sandbox:kernel from docker/sandbox/Dockerfile
make demo-k1-network      # proves internet + no-secrets + the strict (none) mode, workspace-bound
make smoke-sandbox        # same boundary on the one-shot ToolSandbox seam
```

Network default is internet-enabled (`bridge`) for installs/docs. To disable
egress, set `MARATHON_SANDBOX_NETWORK=none` or `sandbox.network: none` in the
agent YAML; `none` wins across options, env, and YAML. No env vars or secrets
ever enter the container.

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
make demo-kernel         # the whole K1-K5 regression umbrella, in one command
```

Or piecewise:

```bash
make demo-k1-brokered    # YAML grants -> brokered git push / gh pr create -> delivery.report_pr
make demo-k1-network     # credential-free sandbox fetches the public internet (needs Docker)
make demo-k2             # one result fans out to the Slack thread AND the doc PR, idempotently
make demo-k3             # clarify -> resume; finished-thread reply -> continuation; PR comments -> revisions
make demo-k4             # mid-BUILD kill -> resume -> exactly one PR
make demo-k5             # @agent status views + cost footers
make demo-slack-app      # the Slack dispatcher end-to-end (ask/feedback/dedupe/resume)
make demo-github-app     # mention -> doc PR -> revise -> merge spawns implementation task
```

All demos are deterministic (fakes/fixtures); the `smoke-*` targets run the
same seams against real services with your `.env` keys.
