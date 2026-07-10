# Marathon — Prerequisites Checklist

External setup that **must be done by a human** before / during implementation (the things
the build can't do for itself). Consolidated from the per-milestone "Human prerequisites" in
`roadmap.md`, ordered by when they're needed. Check items off as you go.

> **Minimum to unblock the critical path** (the §6.1 Pi approval-resume spike + M2): Pi
> installed + **one model key** (Anthropic). Everything else can follow.

---

## A. Decisions

- [x] **License** — Apache 2.0 chosen (per `design.md` §18.3, for the patent grant). `LICENSE`
      committed. _Swap to MIT on request if you prefer._
- [ ] **Copyright holder** — currently "Tanton Gibbs" in `LICENSE`; change if it should be a
      company/org.

---

## B. Models & Pi (unblocks M2 + the spike) — **do these first**

### B1. Pi harness
- [ ] Confirm install: `npm install @earendil-works/pi-coding-agent` (appears to be a public
      package — verify there's no separate license/auth gate). See `pi-details.md`.
- [ ] Note: with Claude Pro/Max via a third-party harness, usage is **billed per token** — we
      use **API keys**, not subscription `/login`.

### B2. Model provider accounts + API keys (with billing + spend caps)
- [ ] **Anthropic (Claude)** — create account at console.anthropic.com → add billing → set a
      monthly usage limit → generate key → env `ANTHROPIC_API_KEY`.
- [ ] **OpenAI (ChatGPT)** — platform.openai.com → billing → usage limit → key →
      `OPENAI_API_KEY`.
- [ ] **OpenRouter** — openrouter.ai → credits/billing → key → `OPENROUTER_API_KEY`
      (configured as an OpenAI-compatible provider).
- [ ] **Where keys go:** local dev → `.env` (gitignored) or Pi's `~/.pi/agent/auth.json`
      (chmod 0600); the app → Marathon's secret store (Marathon injects per-tenant keys at
      runtime via `setRuntimeApiKey`). See `.env.example`.
- [ ] **One-time fixture recording:** run M2's demo once with live keys so CI can use recorded
      provider responses afterward.

---

## C. GitHub (for tools + the document surface) — M3 → M6

- [ ] **Sandbox repo** seeded with sample files / PRs / issues for tests + demos.
- [ ] **GitHub App (or fine-grained token)** — start with **read** scopes (M3); add **write**
      (issues, PRs) at M5; install on the sandbox repo. Registering the App is one click:
      `make register-github-app` stamps a private per-deployment App from a manifest and
      writes the credentials into `.env` + `.keys/` (see `docs/quickstart.md` §3).
- [ ] **Webhooks** (M6): set webhook URL + secret; subscribe to `issue_comment` and
      `pull_request_review_comment`; install on the sandbox repo.
- [ ] **Public endpoint / tunnel** (e.g. ngrok) for Slack + GitHub event delivery in live dev
      (CI uses recorded payloads, so this is dev-only).
- [ ] Sandbox repo configured with **merge rights / branch protection** for the
      design-doc → review → merge flow (M6).

---

## D. Slack (the first surface) — M4 → M5

- [ ] **Create the Slack app** (single `@marathon` bot) at api.slack.com/apps — use
      **"From a manifest"** with `slack-app-manifest.yaml` (repo root) to get the scopes,
      event subscriptions, Socket Mode, and the `/marathon` slash command pre-configured.
      Install to a **test workspace you administer**.
- [ ] Capture the **signing secret** + **bot token** → secret store (env `SLACK_SIGNING_SECRET`,
      `SLACK_BOT_TOKEN`).

---

## E. Infra, security & ops — M0, then M8/M9

- [ ] **CI** — enable GitHub Actions on the repo; grant it any needed secrets (the token has
      `workflow` scope already).
- [ ] **Secret-leak prevention** — run `make hooks` (enables the gitleaks pre-commit scan;
      `brew install gitleaks`) and enable GitHub **secret scanning + push protection** in repo
      settings as the non-bypassable server-side backstop.
- [ ] **Secret-store master key** — provision the key Marathon uses to encrypt secrets at rest
      (generated when we scaffold M0; you hold/rotate it).
- [ ] **Tool-execution sandbox** — decide the isolation route (Pi has **no** sandbox): Gondolin
      micro-VM (needs QEMU + Node ≥ 23.6), Docker, or OpenShell. See `pi-details.md` §7.
- [ ] **Observability backend** (M8, optional) — OTel collector + a backend (Grafana/Honeycomb)
      if exporting externally; pick **budget limit values**.
- [ ] **Security review / sign-off** of trust boundaries (M9); finalize **data-retention**
      values; any open-source release/branding approvals.

---

## Fastest path to first running agent

1. **B1 + B2 (Anthropic key)** → 2. we scaffold **M0** → 3. **M1** spine → 4. **M2** (Pi
   in-process) → run the **§6.1 spike** → 5. **C (GitHub read)** for **M3** tools → 6.
   **D (Slack app)** for **M4** end-to-end demo.
