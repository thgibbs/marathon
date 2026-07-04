# Code Migration Guide

This guide compares the current codebase to the updated design docs and identifies the
implementation migrations needed to make Marathon match the kernel loop:

```text
Slack ask -> design-doc PR -> iterate -> merge-as-approval -> sandboxed code work ->
green-tested code PR -> deliver links back to Slack and the doc PR
```

The code still reflects the earlier M0-M9 milestone implementation. That code is useful as
scaffolding, but it is not aligned with the current product target in `design/00-core-kernel.md`
and `design/29-code-handoff.md`. The migration should optimize for K1-K6 before broad platform
features.

## Completed Work

Progress against the tracks below, most recent first. The "Current mismatch" lists in each
track describe the codebase *before* its work landed; completed tracks carry a status note.

- **Tracks 15–17: model/budget runtime, status + cost, kernel demos — done (2026-07-04).**
  - **Track 15 (model runtime, kernel scope):** model refs are spec-driven everywhere — the
    live GitHub app resolves from `spec.models` (hardcoded fallback gone), the BUILD stage
    resolves the `build` role via `resolveModelRef` (falls back to `default`; advanced
    routing stays deferred per §7.19). The **hard per-task cost cap** (§0.4) is real:
    `assertWithinTaskBudget` (observability) reads `db.sumModelCostUsd(taskId)` and is
    enforced before every turn in `makeAgentTaskStepRunner` AND at every turn boundary
    inside the BUILD run (the awaited `onTurnCheckpoint` hook — a run past its cap aborts
    at the next completed turn with the checkpoint intact; retries fail closed up front).
    The **coherent BUILD loop now exists in a live app**: `makeBuildWiring`
    (packages/github-app/build.ts) assembles, from ONE `AgentSpec`, the Pi runtime with
    `workspaceSandboxFromSpec` (per-agent `sandbox.network` finally reaches BUILD wiring —
    strictness composes: "none" from ANY source — options, env, or YAML — wins, so no
    caller can relax a strict deployment or agent), the brokered `github.exec` (families
    from the YAML)/`git.exec`/`delivery.report_pr` surface behind one gateway, and
    `makeBuildStepRunner` with the spec's model + budget; the live github-app runs it in a
    polling `Worker`. Workers on a shared queue **partition by job kind at dequeue**
    (`Queue.dequeue(..., { kinds })`): the job `kind` is derived from the task's source ref
    at every enqueue (`jobKindForSourceRef` — submit AND resume), BUILD-stage tasks queue
    as `build`, the BUILD worker leases only those, and the Slack worker leases only the
    default kind — a worker can never consume (or dead-letter) another worker's jobs.
    `ClaudeCodeAgentRuntime` remains K7 (explicitly non-blocking).
  - **Track 16 (status + cost):** `@agent status` is a first-class Slack flow —
    `isStatusAsk` short-circuits `handleMention` into `handleStatusAsk` (thread → 
    `findLatestTaskByThread`; read-only, no ack, no task). The §15.3 view is shared:
    `taskStatusView`/`renderStatusText`/`getTaskStatus` (observability/status.ts) render
    headline per `TaskStatus`, current step from `Checkpoint.phase`/latest finding, the
    pending question, completed steps, the delivered PR URL (from the task's `CodeChange`),
    and a "cost so far" footer. The **cost footer is consistent across surfaces**:
    `delivery.report_pr` gained `getCostUsd` (wired to `db.sumModelCostUsd`) and the
    github-app mention results now carry `costUsd` — all rendered by the one
    `renderResultText`. The timeline gained first-class `delivery` events (verification
    commands with exit codes + the reported PR, derived from the `CodeChange`); brokered
    `git.exec`/`github.exec`/report calls already land as `tool_call` events via the
    gateway recorder. Open (deliberately): K5's meta-exit — asking for this change in
    Slack and merging it **through the loop** — is a live ratchet exercise, not a code
    change; this track ships the functionality and the `demo-k5` proof.
  - **Track 17 (demos):** kernel demos now cover K1–K5: `demo-k1-network` (workspace-bound
    sandbox fetches public docs with planted fake secrets invisible inside; strict
    `network: none` blocks egress; Docker-less runs skip gracefully), `demo-k2` (fan-out to
    Slack thread + doc PR, cross-links, per-target idempotency, `no_adapter` visibility,
    `delivery.report_pr` with the cost footer — fully in-memory), `demo-k3` (Slack durable
    wait → answer resumes the SAME task; reply to a finished loop → chained continuation;
    doc-PR comment → same-branch revision; code-PR comment → revision task pinned to the
    branch tip), `demo-k5` (status while waiting/completed/building, PR link in status,
    cost footers from real ModelInvocation rows). **`make demo-kernel`** is the K6 umbrella
    (K1-brokered + K1-network + K2 + K3 + K4 + K5), `make demo` runs kernel demos first,
    and CI now runs ALL kernel demos (k1/k1-brokered/k4 had never been in CI). Old demos
    stay as regressions; `smoke-k1` (a live real-repo PR via brokered `git`/`gh`) remains
    open alongside the existing `smoke-k4`.

- **Track 13: memory migration — done (2026-07-03, §7.12 / OQ-3).** Memory scopes are now
  audiences: `MemoryLevel` is `tenant | project | user | thread` (`agent` retired — migration
  0009 drops the un-gateable agent-level rows, adds `user_id`, renames `source` →
  `provenance`); `agentId` moved off `MemoryScope` onto the item as relevance metadata that
  boosts ranking (`blendedScore` agent-match bonus) and never filters access. Recall is
  **audience-gated**: `RecallQuery` takes a `TaskAudience` computed deterministically at
  prompt-build (`audienceForTask` — GitHub repo → project; Slack DM (`D…`) → user; Slack
  channel → its own pseudo-project until the admin channel↔project mapping exists; unknown →
  tenant; `external` → nothing), `recallableLevels`/`itemRecallable` (audience.ts) enforce
  containment in both stores, with the §7.12 user-`preference` exception. Writes go to the
  narrowest scope (`validateWrite`: each level requires its scope key) and tenant writes fail
  without `provenance.confirmedBy`; `rememberCorrection` is **user-scoped** (requestor
  required) and `promoteMemory` gates promotion (project: light; tenant: confirmation) while
  recording `promotedFrom`. Prompt-builder recall passes scope + audience + agent tag and is
  **best-effort** (a store failure never blocks the loop); `scopeForTask` also learned Slack's
  `thread_ts` and the task's `invokingUserId`. Mem0 adapter re-applies the gate client-side
  from metadata. `demo-m7` now proves write gates, DM-vs-project-vs-external recall,
  promotion, and gated prompt assembly against real pgvector. Egress-ledger integration
  (recalled scopes as sources) stays with the M10 lattice work, per the kernel note.

- **Track 14: agent configuration and quickstart — done (2026-07-03, K6 config surface).**
  `AgentSpec` (@marathon/config) is now the full §6.2/§21.0 shape: `harness` (pi |
  claude-code — the latter validated but refused until K7), the ONE configured `repo`,
  `tools` grants (string or `{ tool, families }` — brokered `gh`/`git` command families),
  `sandbox.network` (default internet-enabled `bridge`), `models` (role → provider:model),
  `budget` (`limit_usd` fails closed, `warn_ratio`), and optional `keywords`;
  `loadAgentSpecs(dir)` reads the agents directory (`MARATHON_AGENTS_DIR`, default
  `agents/`; first file = default agent). `agents/forge.yaml` is the full-config flagship
  spanning the whole loop (draft doc → build → brokered delivery). Bootstraps lost their
  hardcoded bruce/quill defaults: `seedConfiguredAgents` (worker) takes YAML `specs`
  (publishing instructions through `ensureAgentFromSpec` → AgentVersion) or explicit
  descriptors (demos), and throws when nothing is configured; the live Slack app and live
  GitHub app load specs and drive model policy, budget, and the gateway policy
  (`toolPolicyFromSpec` — the spec's repo becomes every grant's `allowedRepos`) from the
  flagship spec. `ghFamiliesForNames` resolves YAML family names against the known `gh`
  families (typos fail the boot); `demo-k1-brokered` now derives its broker surface from
  forge.yaml, proving a family absent from the YAML is refused. Verification config:
  `.marathon/config.yml` discovery already existed (§29.3); the BUILD brief now teaches
  it, and Marathon's own repo carries one (dogfood). Docs: README rewritten around the
  kernel loop; `docs/quickstart.md` is the K6 walkthrough (Slack app, GitHub App +
  brokered-credential model, sandbox toolchain, verify config); `.env.example` gained
  `SLACK_APP_TOKEN`, `GITHUB_OWNER`, `MARATHON_AGENTS_DIR`, `MARATHON_SANDBOX_IMAGE/NETWORK`.
  Still open for K6 proper: `make demo-kernel` and the timed stranger test; per-agent
  `sandbox.network` reaches BUILD wiring when a live BUILD runner consumes specs (Track 15).

- **Track 12: prompt, context, and iteration continuity — done (2026-07-03, K3).**
  Clarifying questions are a first-class durable wait: the runtime seam is
  `AgentTurn.waiting` (Pi exposes an `ask_user` tool when `clarification: true`; the Fake
  runtime scripts `ask:`), the step runners fold it into the checkpoint
  (`pendingQuestion`/`pendingUserInput`, both surviving `parseCheckpoint`), and the worker
  parks the task (`waiting_for_input`, new `"waiting"` outcome + `onWaiting` hook) instead of
  completing or requeueing. `resumeWithInput` (worker/continuity.ts) stages the answer as a
  durable `user:answer` step and re-enqueues; the next turn re-opens the session and consumes
  the fenced answer. Slack replies route as continuations (`isThreadReply`/`parseThreadReply`
  + `db.findLatestTaskByThread`): an answer resumes the wait, a reply to a finished loop
  spawns a chained continuation task, chatter while running is left alone — with the
  clarifying question fanned out in-thread (`❓ … reply in this thread`). Context loading is a
  `SurfaceAdapter.loadContext` duty (Slack `conversations.replies`, GitHub issue comments),
  fenced as `<<<UNTRUSTED thread context>>>` by `buildAgentPrompt` and wired into the Slack
  step runner and both GitHub mention paths. Forge's instructions live in `agents/forge.yaml`
  (`loadAgentSpec`/`parseAgentSpec` in @marathon/config) and publish through an
  `AgentVersion` via `ensureAgentFromSpec` — the same path prompt assembly already reads.
  `make demo-slack-app` now proves ask → durable wait → thread reply → resume → answer.
  Memory recall semantics in the prompt builder stay pre-Track-13 (noted inline).

- **Tracks 10–11: document workflow + sandbox/workspace reality — done (2026-07-03).**
  - **Track 10 (GitHub document workflow):** document branches are deterministic
    (`marathon/doc-<task>-<slug(path)>`; `document.create`/`update` converge on the existing
    branch/PR under webhook retries instead of minting timestamped duplicates). The
    implementation task's input is now `renderImplementationBrief` (worker/prompt.ts): the
    merged plan + pinned base, a deterministic *suggested* branch
    (`suggestedImplementationBranch`), the delivery targets, and the brokered
    `git.exec`/`github.exec`/`delivery.report_pr` contract. The doc artifact's location gains
    `mergeCommitSha` at merge time (`mergeDocumentArtifactLocation`). Mentions on a
    Marathon-created code PR route to `handleCodePrRevision`: a durable revision task chained
    to the implementation task, `base_sha` pinned to the branch's CURRENT tip
    (`findCodeChangeByPr` + `getRef`), one task per review comment (`revisionTaskKey`), with a
    `renderRevisionBrief` teaching same-branch push + same-PR re-report.
  - **Track 11 (sandbox and workspace reality):** `docker/sandbox/Dockerfile` is the pinned
    kernel toolchain image (`make sandbox-image` → `marathon-sandbox:kernel`: git, gh
    (public reads only), Node 22, pnpm via corepack, build tools; credential-free with
    outbound internet per Track 8). `workspaceSandbox`/`workspaceContainerOptions`
    (`packages/agent/src/sandbox-factory.ts`) create BUILD containers from *task workspace
    state* — refusing to run without a binding — with code-task-sized limits; the K4 smoke
    now uses it instead of ad hoc wiring. Workspace lifecycle (clone at commit, credential
    strip, local-git checkout, diff snapshot/replay, teardown) was already `CodeWorkspace` +
    `makeBuildStepRunner`; brokered writes against the task workspace landed with Track 6.
    Tests cover credential-free container args, image pin/overrides, and the no-fallback rule.

- **Tracks 6–9: correction tracks — done (2026-07-03).** The four course corrections landed
  together; `make demo-k1-brokered` proves the corrected loop end to end.
  - **Track 6 (credentialed `gh`/`git` broker):** `packages/tools/src/command-broker.ts` is
    the generic layer (argv-structured `CommandRunner` via `execFile` — no shell; command
    *families* as the policy; `FakeCommandRunner` for tests). `packages/connector-github`
    gains `github.exec` (allowlisted families: `pr view`, `pr diff`, `issue view`,
    `repo view`, read-only `gh api repos/...`, plus `pr create`/`pr edit` for Track 7;
    explicit `--repo` required and allowlist-checked; `GH_TOKEN` injected into the child
    env only) and `git.exec` (`push`/`fetch` on the task's BUILD workspace; the credential
    rides an env-fed inline credential helper, never argv; flags are refused wholesale so
    `--force` is unrepresentable). Reads feed the source ledger; writes are egress-routed;
    exit codes come back as data.
  - **Track 7 (agent-driven delivery):** `delivery.report_pr`
    (`packages/connector-github/src/report-tools.ts`) is the narrow final step — validate
    the PR belongs to the task's configured repo *and exists* (branch/draft state come from
    GitHub via the new `GithubClient.getPullRequest`, never from the model), record it on
    the `CodeChange` (`recordCodeChangeReport`, no tree hash), fan the link out idempotently
    to every delivery target, and never read the diff. The BUILD prompt now teaches normal
    local git + brokered `git.exec`/`github.exec` + `delivery.report_pr`;
    `github.submit_code_changes` is demoted to compatibility/strict mode (kept, with its
    tests and `demo-k1`, until deletion).
  - **Track 8 (sandbox networking):** the Docker sandbox default network flipped from
    `none` to `bridge` — normal outbound internet for installs/docs — with `network: "none"`
    (or `MARATHON_SANDBOX_NETWORK`) as the strict opt-in. The boundary is credential-freedom
    (still no env/secrets in any container); `make smoke-sandbox` now proves both the open
    default and the strict mode.
  - **Track 9 (Proposed Effects for real destructive actions):** `packages/core` gains the
    effect state machine (`proposed → approved|rejected|expired → executing → executed|failed`)
    plus `payloadHashOf`; `ProposedEffectService` (`packages/worker/src/effects.ts`) implements
    propose → hash-bound approve (a changed payload voids approval) → atomic at-most-once
    execute through an `EffectExecutorRegistry` of plain host-side functions
    (`packages/tools/src/effects.ts`) — never a model tool call. `Database` gained the
    guarded state-transition methods. `makeGithubMergeExecutor` is the exemplar: a direct
    `github.merge_pull_request` call still returns typed `requires_proposal`; the executor
    merges only the exact approved proposal. `proposeToolCall`/`executeApproved` stay
    deprecated demo scaffolding; approvals UI/surfaces remain deferred (M10).

- **Track 5: Tool Gateway and Effect Routing — done (2026-07-03).** `Tool` now declares
  `riskAxes` + `defaultMode` (`autonomous | native_review | proposed_effect | disabled`);
  the legacy `riskLevel`/`destructive` fields and the `riskAxesFromLegacy` bridge are gone.
  Policy routes by mode: `document.create/update/revise` and `github.submit_code_changes`
  are **native review** (they run; the PR is the approval), reads/comments/PR-ops are
  autonomous, and `github.merge_pull_request` is a `proposed_effect` — direct calls return
  a typed `requires_proposal` (the old `approval_required`/`needs_approval` vocabulary is
  retired across broker/governed/Pi). The gateway gained a per-task **source ledger**
  (reads declare `sources()`, kernel calibration: repo content is `company_viewable`) and
  deterministic **egress routing** (writes declare `egress()`; tenant-external egress is
  always blocked pending Proposed Effects, internal egress is blocked only after a
  `restricted` read), plus typed agent-visible `ToolBlockedError.code`s
  (`not_granted`/`tool_disabled`/`requires_proposal`/`egress_blocked`/…).
  `proposeToolCall`/`executeApproved` survive as **deprecated** M5 demo scaffolding only —
  M10 Proposed Effects will be immutable artifacts run by a non-model executor, not built
  on them. Agent Hub / in-app approvals stay deferred.

- **Track 4: Worker Runtime and Durable Resume — done (K4, 2026-07-02).**
  `PiAgentRuntime` is now a real multi-turn session runner: per-task session JSONL under
  `sessionDir/<taskId>/`, a point-in-time session snapshot after every completed Pi turn
  (turn atomicity — resume from a snapshot discards the incomplete turn), and per-turn
  checkpoint/tool-event hooks on the runtime seam (`onTurnCheckpoint`/`onEvent`, with
  per-turn model-usage accounting). `makeBuildStepRunner` (`packages/worker`) owns the
  BUILD-stage workspace lifecycle: fresh `CodeWorkspace` at `base_sha` per run, checkpointed
  diff replayed on resume (over-cap diffs spill to `diffDir` as `workspaceDiffRef`),
  `CodeTaskRegistry` binding for the handoff tool, capped tool events into findings, and
  teardown always. `ScriptedBuildRuntime` gives CI a deterministic multi-turn loop with the
  same contract. `make demo-k4` kills a worker mid-BUILD after a per-turn checkpoint and
  asserts a fresh worker resumes with no re-run turns and exactly one PR; `make smoke-k4`
  proves the same with a REAL Pi run (sandboxed Docker tools), SIGKILLed at its first turn
  checkpoint and resumed to a single PR. Durable waits/clarifications stay with Track 12.

- **Track 3: Data Model and Core Types — done (2026-07-02).** Migration 0008 adds
  `proposed_effect`, replaces `risk_level` with `risk_axes` on `tool_invocation` and
  `approval_request`, adds `approval_request.proposed_effect_id`, retires `blocked` from the
  task status constraint, and adds the §10.2 verification fields to `user_identity`. Core
  types follow: `RiskAxes`/`ToolDefaultMode` (with a `riskAxesFromLegacy` bridge until
  Track 5 puts axes on `Tool`), `ProposedEffect`, updated `ApprovalRequest`/`UserIdentity`,
  `blocked` removed from `TaskStatus`, and `Checkpoint` extended with the §11.2 BUILD-stage
  fields (which `parseCheckpoint` now preserves instead of dropping). Memory levels are
  deliberately left to Track 13.

- **Tracks 1 & 2: BUILD → DELIVER code path + task chain — done (K1/K2, PR #1).**
  `packages/code-handoff` implements the §29 contract: host-side `CodeWorkspace`
  (clone at `base_sha`, credential stripping, diff capture/replay, tree hash), the §29.4
  gateway checks (plan-ref match, diff caps, protected paths, secret scan, `marathon/`
  branch namespace, `(task_id, tree_hash)` idempotency), verification discovery, and
  `github.submit_code_changes` where the gateway reads the diff from the workspace.
  `code_change` (migration 0006) and `task.source_task_id` (0007) landed with it. The doc
  PR merge webhook spawns a chained implementation task with `plan_ref`/`base_sha` pinned
  to the merge commit and inherited delivery targets; `packages/surface/src/fanout.ts`
  delivers to every target idempotently. `make demo-k1` proves the path.

All tracks (1–17) have landed. Still open outside the track structure: the K5 meta-exit
(first blood — a change merged to `main` **through the loop**), the K6 timed stranger
test, `smoke-k1`, and the deferred list (§ Do Not Optimize Yet).

New design correction after Tracks 1–5: the original `github.submit_code_changes`
contract is probably too heavy. Marathon should not replace normal `git` and `gh`
workflows with custom semantic GitHub tools unless the workflow truly needs product logic.
The next migration tracks below account for that correction.

## Current Alignment Snapshot

Mostly aligned:

- Durable task/queue spine exists in `packages/core`, `packages/db`, `packages/queue`, and
  `packages/worker`.
- Slack Socket Mode ingestion and GitHub webhook ingestion exist.
- GitHub-backed document draft/revise tools exist.
- The `ToolGateway` exists as a host-side chokepoint.
- Docker sandbox primitives and Pi sandbox-tool routing exist.
- Inspectability primitives for timelines, tool calls, model calls, cost, and budgets exist.

Not aligned with the current design:

- The BUILD -> DELIVER code-writing path exists, but it is too Marathon-owned. It uses
  `github.submit_code_changes` as the main handoff, while the revised direction is that the
  agent should drive normal `git` and `gh` commands.
- The GitHub connector exposes small custom tools where a credentialed `gh`/`git` broker
  would better match how LLM coding agents already work.
- Marathon still treats code delivery as a special semantic tool that decides branch namespace,
  protected path checks, and secret scanning. The revised direction pushes those checks to
  GitHub rulesets, branch protection, CODEOWNERS, secret scanning, gitleaks, and CI.
- The sandbox design is still too network-restrictive for the kernel. The revised direction is
  internet access by default, with no company secrets in the sandbox.
- ~~Memory still has `agent` as an access scope and feedback corrections are
  agent-scoped.~~ Resolved by Track 13: audience scopes (tenant|project|user|thread),
  audience-gated recall, user-scoped corrections with gated promotion.
- ~~Agents are hardcoded in app bootstraps; there is no YAML-defined `forge` flagship
  agent.~~ Resolved by Track 14: bootstraps read configured agents (YAML specs or
  explicit descriptors); `agents/forge.yaml` is the full-config flagship.
- ~~There is no `make demo-kernel`, `make demo-k2`, `make demo-k3`, `make demo-k5`,
  etc.~~ Resolved by Track 17: kernel demos K1–K5 plus the `demo-kernel` umbrella, all
  in CI.

## Migration Principles

1. Build the kernel before broadening the platform.
   Do not spend time on Agent Hub, M11 orchestration, identity linking, broad connector support,
   admin UI, or Claude Code until the Pi-backed dogfood loop works.

2. Treat `design/29-code-handoff.md` as the spec for K1.
   It is concrete enough to implement directly. Do not replace it with another ad hoc code path.

   **Correction:** this principle is now superseded for future work. The kernel still needs a
   trusted delivery path, but Marathon should not own normal `git` decisions. Prefer a
   credentialed `git`/`gh` broker plus a narrow "report the PR I opened" operation.

3. Preserve useful scaffolding, but rename concepts when they are wrong.
   Old milestone demos are still useful tests, but comments and types that teach "destructive
   approval" or "agent-scoped memory" should be migrated because they will keep pulling new code
   in the wrong direction.

4. Add first-class code-path records before adding more behavior.
   The code-writing path must be inspectable and resumable from the start.

5. Do not reimplement GitHub policy in Marathon.
   Branch protection, rulesets, CODEOWNERS, secret scanning, gitleaks, and CI should do that
   job. Marathon should broker credentials, track tasks, and get approval for destructive
   actions.

## Track 1: BUILD -> DELIVER Code Path

Design target:

- `design/29-code-handoff.md`
- `roadmap.md` K1
- `design/10-data-model.md` `CodeChange`

Current code:

- `packages/github-app/src/handlers.ts`
- `packages/connector-github/src/document-tools.ts`
- `packages/connector-github/src/tools.ts`
- `packages/tools/src/workspace.ts`
- `packages/tools/src/sandbox.ts`
- `packages/agent/src/sandbox-tools.ts`

Current mismatch:

- `handleGithubMerge()` finds the produced design-doc artifact, prompts the runtime with
  `EXECUTE_PERSONA`, posts the first line of text, and marks the original task complete.
- It does not spawn a separate implementation task.
- It does not pin `base_sha` to the design-doc merge commit.
- It does not materialize a workspace from the repo.
- It does not run tests or capture verification results.
- It does not push a `marathon/<task>-<slug>` branch.
- It does not open or update a code PR.
- It does not persist a `CodeChange` record.

Required changes:

- Add `github.submit_code_changes` as the single BUILD handoff tool.
- Add a host-side workspace manager that can:
  - clone the configured repo at `base_sha`;
  - strip remotes and credential helpers before sandbox mount;
  - mount the workspace into the sandbox at `/workspace`;
  - capture `git diff base_sha..worktree`;
  - snapshot/replay the diff for K4 resume;
  - destroy the workspace on teardown.
- Extend the GitHub client with branch/commit/PR operations needed by §29:
  - commit a captured diff host-side;
  - push via tenant App credentials;
  - create-or-update a PR;
  - force draft when verification is red;
  - label `marathon:unverified` when needed.
- Implement the §29.4 gateway checks:
  - plan-ref matches the task;
  - diff is non-empty;
  - diff size caps;
  - protected path refusal, especially `.github/workflows/**`;
  - secret scan on added lines;
  - enforced `marathon/` branch namespace;
  - idempotency on `(task_id, tree_hash)`.
- Implement verification discovery:
  - `.marathon/config.yml` `verify:` commands;
  - fallback to the merged plan's Verification section;
  - fallback to agent judgment.
- Record all verification commands, exit codes, and summaries.

Suggested implementation shape:

- New package or module: `packages/code-handoff`.
- New tool factory in `packages/connector-github`: `makeGithubCodeTools(...)`.
- Keep `document.*` tools focused on design-doc drafting and revision.
- Keep `github.submit_code_changes` narrow: model passes metadata; gateway reads the diff from
  the workspace.

## Track 2: Task Chain and Delivery Targets

Design target:

- `design/00-core-kernel.md` K2
- `design/29-code-handoff.md` §29.1 and §29.6
- `design/10-data-model.md` `Task.delivery_targets`

Current code:

- `packages/db/migrations/0001_init.sql`
- `packages/core/src/entities.ts`
- `packages/db/src/index.ts`
- `packages/worker/src/worker.ts`
- `packages/slack-app/src/handlers.ts`
- `packages/github-app/src/handlers.ts`
- `packages/surface/src/types.ts`

Current mismatch:

- `delivery_targets` exists on `task`, but `Database.createTask()` does not accept or write it.
- `Orchestrator.submit()` does not accept or propagate it.
- The design-doc task and implementation task are not modeled as a task chain.
- `handleGithubMerge()` reuses the original document task instead of spawning a new
  implementation task.
- Surface delivery accepts one ref at a time and has no idempotent fan-out abstraction.

Required changes:

- Extend `Database.createTask()` and `Orchestrator.submit()` with `deliveryTargets`.
- Add task-chain metadata. The minimal path can be:
  - source task id on the implementation task;
  - `plan_ref` in the implementation task input/checkpoint;
  - `delivery_targets = [originating Slack thread, doc PR]`.
- On design-doc PR creation, record the originating Slack thread and doc PR target.
- On merge webhook, create an implementation task with:
  - `plan_ref = { repo, doc_path, merge_commit_sha }`;
  - `base_sha = merge_commit_sha`;
  - idempotency key `(repo, doc_path, merge_commit_sha, "implement")`;
  - inherited `delivery_targets`.
- Add fan-out delivery service:
  - deliver progress and final result to every target;
  - idempotency key per `(task_id, target, message_kind)`;
  - link Slack and GitHub surfaces to each other.

## Track 3: Data Model and Core Types

> **Status (2026-07-02): implemented** — see "Completed Work" above. Legacy `blocked`
> rows migrate to `waiting_for_approval`; the memory-level item in the mismatch list
> below is deliberately left to Track 13.

Design target:

- `design/10-data-model.md`
- `design/29-code-handoff.md` §29.8
- `design/11-task-execution-model.md`

Current code:

- `packages/db/migrations/0001_init.sql`
- `packages/db/migrations/0005_memory.sql`
- `packages/core/src/entities.ts`
- `packages/core/src/task-state.ts`
- `packages/core/src/execution.ts`

Current mismatch:

- No `code_change` table or `CodeChange` core type.
- No `proposed_effect` table or `ProposedEffect` core type.
- `tool_invocation` stores `risk_level`, not `risk_axes`.
- `approval_request` has no `proposed_effect_id`.
- `TaskStatus` still includes `blocked`; the design says `blocked` is retired.
- `Checkpoint` is only `{ completedSteps, findings }`; the BUILD-stage contract needs session
  state, turn index, workspace diff snapshot, verification results, and plan refs.
- `UserIdentity` core type is older than the design; it lacks tenant id, verification method,
  status, credential ref, and verified timestamp.
- `memory_item.level` still includes `agent`.

Required changes:

- Add migration for `code_change`.
- Add migration for `proposed_effect` even if M10 stays deferred, so schema and types no longer
  encode the old approval model.
- Replace `risk_level` with `risk_axes` and `default_mode` where tool metadata is stored.
- Add `proposed_effect_id` to `approval_request`.
- Retire `blocked` from TypeScript states and future migrations. Existing databases can keep a
  compatibility migration path, but new code should not transition to `blocked`.
- Replace `Checkpoint` with a discriminated shape or a richer generic object. At minimum,
  BUILD-stage checkpoints need:
  - `phase`;
  - `turnIndex`;
  - `sessionRef` or session JSONL reference;
  - `baseSha`;
  - `workspaceDiffRef` or inline capped diff;
  - `verification`;
  - `planRef`;
  - completed durable effects.
- Update row mappers and database methods for new fields.

## Track 4: Worker Runtime and Durable Resume

> **Status (2026-07-02): implemented** — see "Completed Work" above. The "stop after
> durable wait / clarification" runtime behavior lands with Track 12's waiting states;
> the resume seam it needs (re-open session + continue) is in place.

Design target:

- `design/11-task-execution-model.md` §11.2
- `design/29-code-handoff.md` §29.2 and §29.7
- `roadmap.md` K4

Current code:

- `packages/worker/src/worker.ts`
- `packages/worker/src/agent-step.ts`
- `packages/agent/src/pi.ts`
- `packages/agent/src/types.ts`
- `packages/core/src/execution.ts`

Current mismatch:

- `PiAgentRuntime.nextTurn()` returns `done: true` after one prompt and returns immediately on
  subsequent calls.
- The worker's resume story is only real for synthetic/fake step runners.
- The real Pi path does not reopen a session and continue a multi-turn run.
- The runtime does not manage a per-task workspace lifecycle.
- Checkpoints are saved after a turn, but the real code path has no workspace diff snapshot.
- Tool calls made inside a replayed turn are not consistently idempotent across all effects.

Required changes:

- Make `AgentRuntime` support a real multi-turn tool loop:
  - persist session JSONL per task;
  - expose progress/tool events to the worker;
  - stop after durable wait, clarification, or terminal done;
  - resume from the stored session between turns.
- Add BUILD-stage turn atomicity:
  - crash mid-turn discards incomplete turn;
  - fresh sandbox and workspace on resume;
  - apply checkpointed diff;
  - rerun interrupted commands.
- Add runtime hooks for workspace lifecycle:
  - provision before BUILD turn;
  - mount into sandbox;
  - snapshot diff after completed turn;
  - teardown after terminal state.
- Ensure shell/test outputs are recorded in task timeline without flooding prompts.
- Add K4 tests that kill a real agent/sandbox run, not just a synthetic runner.

## Track 5: Tool Gateway and Effect Routing

> **Status (2026-07-03): implemented** — see "Completed Work" above. Source
> sensitivity is in-process (`InMemorySourceLedger`); persisting the ledger and
> the full egress lattice land with the M10 Proposed Effects work.

Design target:

- `design/07-functional-requirements.md` §7.8 and §7.9
- `policy.md`
- `design/29-code-handoff.md`

Current code:

- `packages/tools/src/types.ts`
- `packages/tools/src/policy.ts`
- `packages/tools/src/gateway.ts`
- `packages/worker/src/approvals.ts`
- `packages/agent/src/governed.ts`
- `packages/tools/src/broker.ts`

Current mismatch:

- Tools still have `riskLevel` and `destructive`.
- Policy is still "destructive requires approval."
- Approvals are attached to tool calls and `executeApproved()` re-runs the tool after approval.
- The design's kernel does not need in-app approvals, while future high-risk effects should be
  Proposed Effects, not direct tool calls.
- There is no source-sensitivity ledger or egress routing in the gateway.
- There are no typed, agent-visible gateway errors for the code handoff path.

Required changes:

- Replace `Tool.destructive` with:
  - `riskAxes`;
  - `defaultMode: autonomous | native_review | proposed_effect | disabled`;
  - connector capability metadata where needed.
- Split kernel-native review from future Proposed Effects:
  - `document.create`, `document.update`, and `github.submit_code_changes` are native review;
  - opening/updating PRs is autonomous because merge is the native approval.
- Add source ledger hooks to all read tools.
- Add egress routing in gateway, but keep kernel calibration minimal:
  - one configured repo;
  - no external egress tools registered;
  - repo content treated company-viewable for now.
- Defer Agent Hub/in-app approvals, but remove the misleading destructive-only model from active
  interfaces.
- For future M10, implement Proposed Effects as immutable artifacts executed by a non-model
  executor. Do not build new approval flows on top of `executeApproved()` as it exists today.

## Correction Tracks: Next Work

The next four tracks should happen before the remaining migration work. They change core
assumptions about GitHub access, code delivery, sandbox networking, and destructive approvals.

## Track 6: Replace Semantic GitHub Tools with a Credentialed `gh`/`git` Broker

> **Status (2026-07-03): implemented** — see "Completed Work" above. `github.exec` +
> `git.exec` with explicit command families; credentials only in the brokered child env.
> The older semantic read tools (`github.read_file`, …) remain registered for existing
> demos but are no longer the direction.

Design correction:

- The agent should use normal GitHub and git workflows where possible.
- Marathon should not force the model through custom tools like `github.read_file` when `gh`
  already gives the model a familiar interface.
- Marathon's main job is to keep write credentials out of the model and the sandbox.

Current code:

- `packages/tools/src/gateway.ts`
- `packages/tools/src/cli.ts`
- `packages/connector-github/src/tools.ts`
- `packages/connector-github/src/code-tools.ts`
- `packages/agent/src/governed.ts`
- `packages/tools/src/broker.ts`

Current mismatch:

- GitHub read/write operations are modeled as custom semantic tools.
- `cli.run` is sandbox-only and does not support host-side credential injection.
- The gateway policy still thinks in terms of registered tool names, not brokered command
  families.
- There is no first-class way for the agent to say:

  ```text
  gh pr view 123 --repo owner/repo --json title,body,files
  ```

  and have Marathon inject the right credential outside the sandbox.

Required changes:

- Add a host-side command broker for credentialed GitHub commands.
- Start with explicit command families:
  - `gh pr view`
  - `gh pr diff`
  - `gh issue view`
  - `gh repo view`
  - selected `gh api` read paths
  - `git fetch` / `git push` only when using the task's configured repo and approved remote
    credential path
- Inject credentials only into the brokered child process.
- Never return the credential to the model.
- Record command, argv, exit code, stdout/stderr summary, and task id.
- Keep arguments structured as `argv: string[]`, not one shell string.
- Prefer allowlisted subcommands over a large policy language.

Suggested shape:

```text
github.exec({
  argv: ["pr", "view", "123", "--repo", "owner/repo", "--json", "title,body,files"]
})
```

The tool name can be Marathon-specific.
The interface should still feel like `gh`.

For `git`, prefer the sandbox for local repo operations and the host broker only for
credentialed network operations.

## Track 7: Replace `github.submit_code_changes` with Agent-Driven Delivery

> **Status (2026-07-03): implemented** — see "Completed Work" above. `delivery.report_pr`
> records + fans out; the BUILD prompt teaches brokered `git`/`gh`;
> `github.submit_code_changes` is demoted to compatibility/strict mode (its tests and
> `demo-k1` stay until deletion). `make demo-k1-brokered` is the corrected-path proof.

Design correction:

- The LLM should decide what files to commit.
- The LLM should decide the branch name, commit message, PR title, and PR summary.
- Git and GitHub should reject empty diffs, protected branches, failed checks, missing reviews,
  and policy violations.
- Marathon should not duplicate GitHub rulesets, branch protection, CODEOWNERS, secret
  scanning, gitleaks, or CI.

Current code:

- `packages/connector-github/src/code-tools.ts`
- `packages/code-handoff/*`
- `packages/worker/src/build-step.ts`
- `packages/github-app/src/handlers.ts`
- `packages/surface/src/fanout.ts`

Current mismatch:

- `github.submit_code_changes` reads the workspace diff itself.
- The gateway enforces branch naming, protected path checks, secret scanning, diff caps, and
  PR creation.
- That makes Marathon own too much of the normal git workflow.
- The model has less control over the workflow than it should.

Required changes:

- Demote `github.submit_code_changes` from the primary delivery path.
- Let the agent use normal commands:

  ```text
  git status
  git diff
  git add
  git commit
  git push
  gh pr create
  gh pr edit
  gh pr view
  ```

- Use the credentialed broker from Track 6 for `git push` and `gh pr create/edit` when write
  credentials are needed.
- Replace the final handoff with a narrow delivery-report operation:

  ```text
  delivery.report_pr({
    pr_url,
    summary,
    verification
  })
  ```

- `delivery.report_pr` should:
  - validate that the PR belongs to the configured repo;
  - record the PR URL on the task / `CodeChange`;
  - deliver the link to the Slack thread and plan PR;
  - mark the implementation task delivered;
  - avoid reading or rewriting the diff.

What moves out of Marathon:

- Empty diff checks move to git.
- Protected branch/file policy moves to GitHub rulesets, branch protection, CODEOWNERS, and CI.
- Secret scanning moves to GitHub secret scanning, gitleaks, pre-commit, or CI.
- Branch naming is suggested by Marathon but chosen by the agent or repo convention.

What stays in Marathon:

- Task chain.
- Workspace lifecycle.
- Durable resume.
- Credential brokering for write operations.
- Approval workflow for destructive operations.
- Delivery fan-out.
- Audit/timeline.

Compatibility note:

- Keep the existing `github.submit_code_changes` tests until the replacement path has equal
  demo coverage.
- Then either delete it or keep it only as an optional strict mode.

## Track 8: Simplify Sandbox Networking for the Kernel

> **Status (2026-07-03): implemented** — see "Completed Work" above. Sandbox default is
> internet-enabled (`bridge`); `network: "none"` / `MARATHON_SANDBOX_NETWORK` is the
> strict opt-in; containers stay credential-free. The egress broker stays a later
> hardening track.

Design correction:

- The sandbox needs internet access to be useful.
- It may need to install packages.
- It may need to read docs, search errors, download types, or use framework CLIs.
- The first boundary should be "no company secrets in the sandbox", not "no network".

Current code / design mismatch:

- The design language still assumes network-denied sandboxes except broker/model paths.
- The older sandbox track asked for "no network except allowed broker/model-proxy paths."
- That is too restrictive for the first version.

Required changes:

- Give the sandbox normal outbound internet access in the kernel.
- Keep these out of the sandbox:
  - GitHub write tokens;
  - Slack tokens;
  - production API keys;
  - database credentials;
  - cloud credentials;
  - Marathon secret-store access.
- Allow normal project dependency work:

  ```text
  pnpm install
  pnpm add package
  npm install
  pip install package
  cargo add crate
  curl docs
  ```

- Treat dependency changes as normal PR content:
  - `package.json`;
  - lockfiles;
  - requirements files;
  - manifests.
- Do not commit caches or installed dependency directories.
- Put repeatability pressure on the repo and CI, not on a closed sandbox network.

Long-term hardening:

- Add an internet egress broker later.
- It can log requests and block obvious bad paths:
  - cloud metadata IPs;
  - private IP ranges;
  - known paste sites;
  - large uploads;
  - obvious secret patterns;
  - arbitrary POSTs if strict mode is enabled.
- Do not claim this fully prevents exfiltration.
- It is visibility and risk reduction, not perfect data-loss prevention.

## Track 9: Narrow Proposed Effects to Real Destructive Actions

> **Status (2026-07-03): implemented** — see "Completed Work" above. `ProposedEffectService`
> + non-model `EffectExecutor`s with hash-bound approval and at-most-once execution;
> `github.merge_pull_request` is the exemplar. Approval *surfaces* (Slack buttons, Agent
> Hub) remain deferred with M10.

Design correction:

- Marathon should still own approval for destructive or high-risk actions.
- But normal PR creation and normal code delivery should use GitHub's native review flow.
- Marathon approval should be rare.

Examples that should need approval or a native review surface:

- Delete files from the main branch directly.
- Merge a PR.
- Delete a branch.
- Delete an issue.
- Change production data.
- Deploy to production.
- Rotate a secret.
- Send external email.
- Perform broad external/public posting.

Required changes:

- Keep normal code changes as:

  ```text
  agent opens PR
  human reviews PR
  human merges PR
  ```

- For direct destructive actions, use:

  ```text
  propose exact action
  human approves exact action
  non-model executor performs exact action
  ```

- Do not use the old `executeApproved()` tool-call replay model for new work.
- Approval must bind to the exact artifact or exact mutation.
- If the artifact changes, approval is void.
- The model should not directly hold the credential needed to perform the destructive action.

## Remaining Tracks After The Correction

## Track 10: GitHub Document Workflow

> **Status (2026-07-03): implemented** — see "Completed Work" above. Deterministic doc
> branches with retry convergence, implementation/revision briefs carrying the brokered
> delivery contract, merge metadata on the artifact, and code-PR mention → revision task
> pinned to the branch tip.

Design target:

- `design/06-core-user-journeys.md` §6.8
- Track 7 in this guide: agent-driven `git`/`gh` delivery plus `delivery.report_pr`
- `roadmap.md` K1-K3

Current code:

- `packages/github-app/src/handlers.ts`
- `packages/surface-github/src/parse.ts`
- `packages/connector-github/src/document-tools.ts`
- `demos/m6/run.ts`
- `demos/github-app/run.ts`

Current mismatch:

- The document workflow was originally wired toward `github.submit_code_changes`.
- A merged document PR should start an implementation task that uses normal `git`/`gh`, not a
  semantic code-handoff tool.
- `document.create` branches are timestamp-based, not deterministic/idempotent.
- `document.create` and `document.update` do not fully bind to base SHA / plan refs in the way
  the kernel needs.
- `document.revise` commits directly to the doc PR branch and retries on stale SHA, which is
  directionally useful but not tied into task-chain semantics.
- Code PR revision comments are not fully connected to the new brokered `git`/`gh` delivery
  path.

Required changes:

- Use `mergeCommitSha` as the implementation task's `base_sha`.
- Treat design-doc merge as spawning a new implementation task, not resuming/completing the doc
  task.
- Put the merged plan, base SHA, suggested branch, delivery targets, and `delivery.report_pr`
  contract into the implementation prompt.
- Store plan doc path, branch, PR number, and merge commit in `DocumentArtifact` or
  `CodeChange.plan_ref`.
- Make document branch naming deterministic enough for idempotency, or record enough metadata to
  converge under webhook retries.
- Add code-PR mention handling:
  - detect mentions on a Marathon-created code PR;
  - spawn revision task;
  - pin base SHA to the current task branch tip;
  - let the agent update the same branch/PR through brokered `git`/`gh`;
  - use `delivery.report_pr` to record and fan out the updated PR link.

## Track 11: Sandbox and Workspace Reality

> **Status (2026-07-03): implemented** — see "Completed Work" above. Pinned toolchain image
> (`make sandbox-image`), `workspaceSandbox` container factory driven by task workspace
> state, credential-free + internet-enabled by default; workspace lifecycle and brokered
> writes had landed with Tracks 1–9.

Design target:

- `design/12-security-design.md` §12.6
- Track 8 in this guide: internet-enabled sandbox with no company secrets
- `roadmap.md` K1

Current code:

- `packages/tools/src/sandbox.ts`
- `packages/tools/src/workspace.ts`
- `packages/agent/src/sandbox-tools.ts`
- `demos/m9/*`

Current mismatch:

- Docker sandbox primitives exist, but the code-task workspace still needs to feel like a normal
  repo checkout that an LLM can drive with `git`, package managers, test commands, and local
  tooling.
- `DockerSandbox` is one-command; `DockerContainer` is persistent, but neither is tied into a
  task-scoped code workspace manager.
- `Workspace` can create temp dirs and write files, but cannot clone, strip credentials, apply
  checkpoint diffs, or prepare a normal git remote setup for brokered pushes.
- `sandboxFromEnv()` only covers `ToolSandbox`, not the Pattern-2 `DockerContainer` lifecycle
  needed by Pi's sandboxed tools.
- The default image is Alpine; the kernel needs a pinned toolchain image with git, `gh`, Node,
  pnpm, common build tools, and the repo's verifier tools.
- The older no-network sandbox target is too restrictive for the kernel.

Required changes:

- Add a pinned kernel toolchain image.
- Add `WorkspaceManager` for code tasks:
  - clone at commit;
  - strip remotes / credential helpers;
  - keep a normal git checkout that supports local `git status`, `git diff`, `git add`, and
    `git commit`;
  - mount into `DockerContainer`;
  - apply checkpointed diff on resume;
  - enforce teardown.
- Give the container normal outbound internet access for package installs, docs, public
  searches, and framework CLIs.
- Wire `PiAgentRuntime.sandbox.createContainer()` from task workspace state, not ad hoc smoke
  setup.
- Make brokered GitHub writes operate against the task workspace without placing credentials in
  the sandbox.
- Add tests for:
  - no credentials in sandbox env;
  - outbound internet access works for normal dependency/doc lookups;
  - credentialed GitHub writes require the broker, not sandbox credentials;
  - diff snapshot/replay.

## Track 12: Prompt, Context, and Iteration Continuity

> **Status (2026-07-03): implemented** — see "Completed Work" above. Durable clarifying
> questions (ask → park → thread-reply resume), Slack continuation routing, adapter-loaded
> fenced context, and Forge instructions from YAML through AgentVersion. BUILD prompt items
> landed earlier with Tracks 7/10; memory-recall semantics move with Track 13; full YAML
> agent config (harness/tool grants/budgets) is Track 14.

Design target:

- `design/07-functional-requirements.md` §7.18
- `roadmap.md` K3
- `design/21-example-agents.md` Forge

Current code:

- `packages/worker/src/prompt.ts`
- `packages/github-app/src/handlers.ts`
- `packages/slack-app/src/handlers.ts`
- `packages/surface/src/types.ts`

Current mismatch:

- Prompt assembly is minimal and does not load Slack thread context through a surface adapter.
- GitHub document context is passed manually only in the revise path.
- Clarifying questions are not a first-class durable wait path in the apps.
- Slack replies do not route as continuations of existing loop tasks.
- BUILD prompts still assume the old code-handoff contract instead of telling the agent to use
  normal `git`/`gh`, run verification, open a PR, and call `delivery.report_pr`.
- The prompt builder recalls old memory semantics.
- There is no Forge-specific prompt loaded from YAML.

Required changes:

- Expand `SurfaceAdapter` toward the design:
  - identity resolution;
  - context loading;
  - progress;
  - delivery;
  - feedback;
  - status.
- Add thread-continuation routing:
  - Slack reply in a task thread -> continuation task or resumed wait;
  - doc PR comment -> revise the design doc;
  - code PR comment -> revise implementation branch.
- Update BUILD prompt assembly:
  - include the merged plan path and merge commit;
  - include the workspace location and current branch/base state;
  - include suggested `git`/`gh` commands, not custom GitHub semantic tools;
  - include `delivery.report_pr` as the final reporting step;
  - make clear that package installs and web/doc lookup are allowed in the sandbox;
  - make clear that GitHub writes must use the brokered credential path.
- Represent clarifying questions as `waiting_for_input`:
  - ask;
  - end turn;
  - resume with user answer.
- Load Forge instructions from YAML and pass them through `AgentVersion`.
- Keep all surface/document/tool content fenced as untrusted.

## Track 13: Memory Migration

> **Status (2026-07-03): implemented** — see "Completed Work" above. Audience scopes +
> gated recall/writes in both stores (migration 0009); corrections user-scoped with
> promotion gates; recall best-effort in prompt assembly. The egress-ledger tie-in
> (recalled scopes as sources) stays with M10, per the kernel note below.

Design target:

- `design/07-functional-requirements.md` §7.12
- `design/10-data-model.md` `MemoryItem`
- `open-questions.md` OQ-3 resolution

Current code:

- `packages/memory/src/types.ts`
- `packages/memory/src/fake-store.ts`
- `packages/memory/src/pgvector-store.ts`
- `packages/memory/src/feedback.ts`
- `packages/memory/src/project.ts`
- `packages/db/migrations/0005_memory.sql`

Current mismatch:

- `MemoryLevel` includes `agent`.
- Feedback corrections are written as long-term agent-scoped memory.
- Recall unions tenant + project + agent + thread based on scope keys, not audience containment.
- There is no `user` scope.
- There is no `TaskAudience`.
- Memory still assumes the older source-ledger/egress model is a core security boundary.
- Memory provenance does not cleanly distinguish useful recall metadata from hard access
  control.

Required changes:

- Replace memory levels with `tenant | project | user | thread`.
- Treat `agentId` as relevance metadata only.
- Add task-aware recall only where it is needed for product behavior.
- Add user-scoped corrections by default; add explicit promotion gates for project/tenant.
- Keep provenance on memory writes, but do not make the kernel depend on a full egress lattice.
- Avoid treating memory recall as a blocker for the agent-driven `git`/`gh` loop.
- Update migrations, stores, tests, and prompt assembly.

Kernel note:

- Full memory refactor is explicitly deferred behind the kernel. However, avoid building new
  kernel behavior that depends on agent-scoped memory.

## Track 14: Agent Configuration and Quickstart

> **Status (2026-07-03): implemented** — see "Completed Work" above. Full `AgentSpec`
> YAML surface (harness, one repo, tool grants/families, sandbox network, models,
> budget), `agents/forge.yaml` flagship, spec-driven bootstraps, quickstart docs.
> Still open for K6 proper: `make demo-kernel` and the timed stranger test (Track 17);
> per-agent `sandbox.network` BUILD wiring lands with Track 15.

Design target:

- `design/21-example-agents.md` Forge
- `design/00-core-kernel.md` K6
- `roadmap.md` K6

Current code:

- `packages/config/src/index.ts`
- `packages/slack-app/src/bootstrap.ts`
- `packages/github-app/src/bootstrap.ts`
- `README.md`
- `.env.example`

Current mismatch:

- `@marathon/config` only loads DB URL and secret key.
- Slack app bootstraps `bruce` in code.
- GitHub app bootstraps `quill` in code.
- There is no YAML agent config loader.
- There is no `forge` flagship agent in runtime config.
- No per-agent `harness`, repo, brokered command grants, sandbox network mode, model policy, or
  verify config.
- No quickstart that walks a stranger through the kernel loop.

Required changes:

- Add YAML config support for agents:
  - `name`, `display_name`, `description`;
  - `harness`;
  - one configured repo;
  - instructions;
  - tool grants, including brokered `gh`/`git` command families;
  - sandbox network mode, defaulting to internet-enabled with no company secrets;
  - model policy;
  - budget caps.
- Seed/load `forge` from YAML.
- Update Slack and GitHub bootstraps to read configured agents instead of hardcoded defaults.
- Add `.marathon/config.yml` support in target repos for verification commands.
- Add quickstart setup for GitHub credentials:
  - read credentials can be direct or brokered;
  - write credentials are brokered;
  - destructive actions require approval or native review.
- Rewrite README around the kernel loop, not milestone demos.
- Add setup docs for Slack app + GitHub App + sandbox toolchain.

## Track 15: Model Runtime and Harness Breadth

> **Status (2026-07-04): implemented (kernel scope)** — see "Completed Work" above.
> Spec-driven model refs (+ `build` role), hard per-task budget in both step runners
> (mid-BUILD abort at turn boundaries), and the coherent BUILD loop live in the
> github-app (`makeBuildWiring`: spec-driven sandbox network + brokered tools +
> report). Advanced routing (tiers, constraint filter, fallback chains) and
> `ClaudeCodeAgentRuntime` stay deferred (§7.19 / K7), per the kernel note below.

Design target:

- `design/07-functional-requirements.md` §7.5 and §7.19
- `roadmap.md` K7

Current code:

- `packages/model-gateway/src/index.ts`
- `packages/agent/src/pi.ts`
- `packages/agent/src/types.ts`

Current mismatch:

- Only Pi and Fake runtimes exist.
- Model selection is effectively a passed-in model ref; there is no step role -> tier routing,
  constraint filtering, fallback chain, or per-agent harness override.
- Runtime/tool wiring is still shaped around custom semantic tools and `submit_code_changes`.
- The BUILD runtime must expose sandbox shell/file tools, brokered `gh`/`git`, and
  `delivery.report_pr` in one coherent loop.
- No Claude Code runtime exists.

Required changes:

- For kernel: keep Pi as the first runtime and adapt its tool surface to the new delivery path.
- Ensure the runtime can use:
  - sandboxed file/shell tools with internet access;
  - host-side brokered `gh`/`git` for credentialed GitHub operations;
  - `delivery.report_pr` for final delivery.
- Add config-level model ref and hard per-task budget.
- Defer advanced model routing until after the loop works.
- Add `ClaudeCodeAgentRuntime` only after or in parallel with the brokered delivery loop, without
  blocking first dogfood success.

## Track 16: Observability, Status, and Cost

> **Status (2026-07-04): implemented** — see "Completed Work" above. `@agent status`
> (§15.3 shared rendering from checkpoint phase + records), consistent cost footers on
> Slack and GitHub delivery, first-class `delivery` timeline events. The K5 meta-exit
> (built via the loop) is a live exercise that stays open.

Design target:

- `design/15-surface-ux-design.md` §15.3 and §15.5
- `roadmap.md` K5

Current code:

- `packages/observability/src/timeline.ts`
- `packages/observability/src/budget.ts`
- `packages/slack-app/src/handlers.ts`
- `packages/db/src/index.ts`

Current mismatch:

- Task timeline exists as data reads, but there is no Slack `@marathon status` flow.
- The final Slack handler computes cost and includes it in `StructuredResult`, but rendering is
  surface-specific and not clearly the silent footer behavior.
- Current-step reporting is weak because checkpoints are just findings/completedSteps.
- Brokered `git`/`gh` commands, sandbox package installs, verification commands, PR creation,
  and `delivery.report_pr` are not yet first-class timeline events.

Required changes:

- Add status command parsing and routing for Slack thread context.
- Add status rendering for:
  - running;
  - waiting for input;
  - waiting for approval/native review;
  - completed/failed/expired.
- Record workspace, brokered command, verification, PR opened/updated, and delivery-report
  events.
- Show the current PR URL once `delivery.report_pr` has been called.
- Add final cost footer consistently across Slack and GitHub delivery.
- Build K5 through the loop once K1-K4 are ready.

## Track 17: Demos and Regression Proofs

> **Status (2026-07-04): implemented** — see "Completed Work" above. `demo-k1-network`,
> `demo-k2`, `demo-k3`, `demo-k5`, the `demo-kernel` umbrella (K1-brokered + K1-network +
> K2 + K3 + K4 + K5), kernel-first `make demo` ordering, and CI coverage for every kernel
> demo. Old milestone demos stay as regressions; `smoke-k1` remains open.

Design target:

- `roadmap.md` K1-K6
- `design/00-core-kernel.md` §0.6

Current code:

- `demos/m0` through `demos/m9`
- `demos/slack-app`
- `demos/github-app`
- `Makefile`

Current mismatch:

- Existing demos prove old milestones, including destructive approval.
- `demo-k1` and `demo-k4` prove the older `github.submit_code_changes` path, not the corrected
  brokered `git`/`gh` path.
- There is no `demo-k2`, `demo-k3`, `demo-k5`, or `demo-kernel` for the corrected loop.
- `demo-m6` demonstrates doc PR merge -> text execution, not agent-driven `git`/`gh` delivery.
- No demo proves internet-enabled sandbox work without company credentials.

Required changes:

- Keep old demos as regression tests where still meaningful.
- Add kernel demos:
  - `make demo-k1`: fake merged plan -> sandbox edit/test -> brokered `git`/`gh` code PR;
  - `make demo-k1-network`: sandbox installs or fetches a public package/doc without secrets;
  - `make demo-k2`: delivery targets fan out to Slack and doc PR;
  - `make demo-k3`: comment/reply iteration continuity;
  - `make demo-k4`: kill mid-BUILD -> resume -> one PR through brokered delivery;
  - `make demo-k5`: status + cost;
  - `make demo-kernel`: full loop umbrella.
- Update `make demo` ordering to prioritize kernel demos.
- Add live smoke `make smoke-k1` for a real small PR in a sandbox repo using `git`/`gh`.

## Suggested Build Order

Tracks 1–5 already landed under the older code-handoff design. The next build order should
course-correct instead of deepening that path:

1. Add the credentialed `gh`/`git` broker.
2. Give the sandbox internet access while keeping all company credentials out.
3. Teach the BUILD prompt to use normal `git` and `gh` commands.
4. Add `delivery.report_pr`.
5. Rework K1/K2 demos around agent-driven `git`/`gh` delivery.
6. Keep `github.submit_code_changes` as compatibility until the new path is proven.
7. Then delete or demote `github.submit_code_changes` to optional strict mode.
8. Continue with K3 iteration paths for doc PR comments, Slack replies, and code PR revisions.
9. Forge YAML config and quickstart.
10. Status/cost built through the loop.
11. Only then revisit full Proposed Effects, memory refactor, identity linking, M11, network
    egress broker, and Claude Code.

## Files Most Likely to Change First

- `packages/db/migrations/*`
- `packages/core/src/entities.ts`
- `packages/core/src/execution.ts`
- `packages/core/src/task-state.ts`
- `packages/db/src/index.ts`
- `packages/worker/src/worker.ts`
- `packages/worker/src/agent-step.ts`
- `packages/worker/src/prompt.ts`
- `packages/agent/src/pi.ts`
- `packages/tools/src/types.ts`
- `packages/tools/src/policy.ts`
- `packages/tools/src/gateway.ts`
- `packages/tools/src/cli.ts`
- `packages/tools/src/workspace.ts`
- `packages/tools/src/sandbox.ts`
- `packages/connector-github/src/client.ts`
- `packages/connector-github/src/code-tools.ts`
- `packages/connector-github/src/document-tools.ts`
- `packages/connector-github/src/tools.ts`
- `packages/github-app/src/handlers.ts`
- `packages/slack-app/src/handlers.ts`
- `packages/surface/src/types.ts`
- `packages/config/src/index.ts`
- `Makefile`
- `README.md`

## Do Not Optimize Yet

These are important in the full design, but should not block first blood:

- Agent Hub / in-app approvals.
- Full Proposed Effects UI.
- Identity linking.
- Full egress lattice.
- Advanced model routing and fallback.
- Mem0/Zep memory behavior.
- Admin console.
- Claude Code harness, unless someone works it in parallel without slowing K1-K4.
- M11 frontier orchestration.
- MicroVM backend.
- Strict internet egress broker / DLP for the sandbox. Keep it as a later hardening track;
  the kernel sandbox needs broad internet access and no company secrets.

The first proof is simpler and harder: Marathon must produce a real, reviewed, tested PR to
Marathon through its own loop.
