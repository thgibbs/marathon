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
  checkpoint and resumed to a single PR. Durable waits/clarifications stay with Track 8.

- **Track 3: Data Model and Core Types — done (2026-07-02).** Migration 0008 adds
  `proposed_effect`, replaces `risk_level` with `risk_axes` on `tool_invocation` and
  `approval_request`, adds `approval_request.proposed_effect_id`, retires `blocked` from the
  task status constraint, and adds the §10.2 verification fields to `user_identity`. Core
  types follow: `RiskAxes`/`ToolDefaultMode` (with a `riskAxesFromLegacy` bridge until
  Track 5 puts axes on `Tool`), `ProposedEffect`, updated `ApprovalRequest`/`UserIdentity`,
  `blocked` removed from `TaskStatus`, and `Checkpoint` extended with the §11.2 BUILD-stage
  fields (which `parseCheckpoint` now preserves instead of dropping). Memory levels are
  deliberately left to Track 9.

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

Not started: Tracks 6–13 except K4 (document-workflow iteration paths, sandbox
toolchain image, prompt/context continuity, memory migration, Forge YAML
config/quickstart, model routing, status/cost UX, kernel demos beyond K1/K4).

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

- The BUILD -> DELIVER code-writing path is missing.
- The GitHub merge path "executes" by asking the model for text, not by creating a sandboxed
  workspace, running tests, and opening a code PR.
- Tool policy is still `destructive: boolean` + `riskLevel`; the design uses risk axes,
  default modes, native review, and Proposed Effects later.
- `ProposedEffect` and `CodeChange` are not represented in schema or core types.
- Memory still has `agent` as an access scope and feedback corrections are agent-scoped.
- The real Pi runtime is effectively single-turn; durable resume of a real code-writing run is
  not implemented.
- Agents are hardcoded in app bootstraps; there is no YAML-defined `forge` flagship agent.
- `delivery_targets` exists in the schema but is not populated or used for fan-out delivery.
- There is no `make demo-kernel`, `make demo-k1`, `make demo-k2`, etc.

## Migration Principles

1. Build the kernel before broadening the platform.
   Do not spend time on Agent Hub, M11 orchestration, identity linking, broad connector support,
   admin UI, or Claude Code until the Pi-backed dogfood loop works.

2. Treat `design/29-code-handoff.md` as the spec for K1.
   It is concrete enough to implement directly. Do not replace it with another ad hoc code path.

3. Preserve useful scaffolding, but rename concepts when they are wrong.
   Old milestone demos are still useful tests, but comments and types that teach "destructive
   approval" or "agent-scoped memory" should be migrated because they will keep pulling new code
   in the wrong direction.

4. Add first-class code-path records before adding more behavior.
   The code-writing path must be inspectable and resumable from the start.

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
> below is deliberately left to Track 9.

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
> durable wait / clarification" runtime behavior lands with Track 8's waiting states;
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

## Track 6: GitHub Document Workflow

Design target:

- `design/06-core-user-journeys.md` §6.8
- `design/29-code-handoff.md`
- `roadmap.md` K1-K3

Current code:

- `packages/github-app/src/handlers.ts`
- `packages/surface-github/src/parse.ts`
- `packages/connector-github/src/document-tools.ts`
- `demos/m6/run.ts`
- `demos/github-app/run.ts`

Current mismatch:

- A merged document PR marks the original task complete after a text response.
- The merge event parser captures `mergeCommitSha`, but `handleGithubMerge()` ignores it.
- `document.create` branches are timestamp-based, not deterministic/idempotent.
- `document.create` and `document.update` do not fully bind to base SHA / plan refs in the way
  the kernel needs.
- `document.revise` commits directly to the doc PR branch and retries on stale SHA, which is
  directionally useful but not tied into task-chain semantics.
- Code PR revision comments are not supported.

Required changes:

- Use `mergeCommitSha` as the implementation task's `base_sha`.
- Treat design-doc merge as spawning a new implementation task, not resuming/completing the doc
  task.
- Store plan doc path, branch, PR number, and merge commit in `DocumentArtifact` or
  `CodeChange.plan_ref`.
- Make document branch naming deterministic enough for idempotency, or record enough metadata to
  converge under webhook retries.
- Add code-PR mention handling:
  - detect mentions on a Marathon-created code PR;
  - spawn revision task;
  - pin base SHA to the current task branch tip;
  - use the same `github.submit_code_changes` handoff to update the same PR.

## Track 7: Sandbox and Workspace Reality

Design target:

- `design/12-security-design.md` §12.6
- `design/29-code-handoff.md` §29.2
- `roadmap.md` K1

Current code:

- `packages/tools/src/sandbox.ts`
- `packages/tools/src/workspace.ts`
- `packages/agent/src/sandbox-tools.ts`
- `demos/m9/*`

Current mismatch:

- Docker sandbox primitives exist, but there is no repo materialization or code-task workspace
  lifecycle.
- `DockerSandbox` is one-command; `DockerContainer` is persistent, but neither is tied into a
  task-scoped code workspace manager.
- `Workspace` can create temp dirs and write files, but cannot clone, strip credentials, apply
  diffs, or compute tree hashes.
- `sandboxFromEnv()` only covers `ToolSandbox`, not the Pattern-2 `DockerContainer` lifecycle
  needed by Pi's sandboxed tools.
- The default image is Alpine; the kernel needs a pinned toolchain image with git, Node, pnpm,
  and the repo's verifier tools.

Required changes:

- Add a pinned kernel toolchain image.
- Add `WorkspaceManager` for code tasks:
  - clone at commit;
  - strip remotes / credential helpers;
  - mount into `DockerContainer`;
  - compute diff and tree hash;
  - apply checkpointed diff on resume;
  - enforce teardown.
- Wire `PiAgentRuntime.sandbox.createContainer()` from task workspace state, not ad hoc smoke
  setup.
- Add tests for:
  - no credentials in sandbox env;
  - no network except allowed broker/model-proxy paths;
  - protected path refusal;
  - diff snapshot/replay.

## Track 8: Prompt, Context, and Iteration Continuity

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
- Represent clarifying questions as `waiting_for_input`:
  - ask;
  - end turn;
  - resume with user answer.
- Load Forge instructions from YAML and pass them through `AgentVersion`.
- Keep all surface/document/tool content fenced as untrusted.

## Track 9: Memory Migration

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
- Recalled memory is not reported to the egress/source ledger.
- Memory provenance lacks sensitivity fields expected by the design.

Required changes:

- Replace memory levels with `tenant | project | user | thread`.
- Treat `agentId` as relevance metadata only.
- Add `TaskAudience` and audience-gated recall.
- Add user-scoped corrections by default; add explicit promotion gates for project/tenant.
- Add provenance sensitivity on memory writes.
- Report recalled scopes to the source ledger.
- Update migrations, stores, tests, and prompt assembly.

Kernel note:

- Full memory refactor is explicitly deferred behind the kernel. However, avoid building new
  kernel behavior that depends on agent-scoped memory.

## Track 10: Agent Configuration and Quickstart

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
- No per-agent `harness`, repo, tool grants, model policy, or verify config.
- No quickstart that walks a stranger through the kernel loop.

Required changes:

- Add YAML config support for agents:
  - `name`, `display_name`, `description`;
  - `harness`;
  - one configured repo;
  - instructions;
  - tools/grants;
  - model policy;
  - budget caps.
- Seed/load `forge` from YAML.
- Update Slack and GitHub bootstraps to read configured agents instead of hardcoded defaults.
- Add `.marathon/config.yml` support in target repos for verification commands.
- Rewrite README around the kernel loop, not milestone demos.
- Add setup docs for Slack app + GitHub App + sandbox toolchain.

## Track 11: Model Runtime and Harness Breadth

Design target:

- `design/07-functional-requirements.md` §7.5 and §7.19
- `roadmap.md` K7

Current code:

- `packages/model-gateway/src/index.ts`
- `packages/agent/src/pi.ts`
- `packages/agent/src/types.ts`

Current mismatch:

- Only Pi and Fake runtimes exist.
- `PiAgentRuntime` is single-turn and not a durable multi-turn session runner.
- Model selection is effectively a passed-in model ref; there is no step role -> tier routing,
  constraint filtering, fallback chain, or per-agent harness override.
- No Claude Code runtime exists.

Required changes:

- For kernel: fix Pi multi-turn/resume first.
- Add config-level model ref and hard per-task budget.
- Defer advanced model routing until after the loop works.
- Add `ClaudeCodeAgentRuntime` only after or in parallel with K1-K4, without blocking first
  dogfood success.

## Track 12: Observability, Status, and Cost

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
- BUILD-stage verification and workspace events cannot appear in timelines because they are not
  recorded yet.

Required changes:

- Add status command parsing and routing for Slack thread context.
- Add status rendering for:
  - running;
  - waiting for input;
  - waiting for approval/native review;
  - completed/failed/expired.
- Record workspace, verification, handoff, PR opened/updated, and delivery events.
- Add final cost footer consistently across Slack and GitHub delivery.
- Build K5 through the loop once K1-K4 are ready.

## Track 13: Demos and Regression Proofs

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
- No `demo-k1`, `demo-k2`, `demo-k3`, `demo-k4`, `demo-k5`, or `demo-kernel`.
- `demo-m6` demonstrates doc PR merge -> text execution, not code PR delivery.
- No demo kills a real code-writing BUILD stage and resumes it.

Required changes:

- Keep old demos as regression tests where still meaningful.
- Add kernel demos:
  - `make demo-k1`: fake merged plan -> sandbox edit/test -> code PR;
  - `make demo-k2`: delivery targets fan out to Slack and doc PR;
  - `make demo-k3`: comment/reply iteration continuity;
  - `make demo-k4`: kill mid-BUILD -> resume -> one PR;
  - `make demo-k5`: status + cost;
  - `make demo-kernel`: full loop umbrella.
- Update `make demo` ordering to prioritize kernel demos.
- Add live smoke `make smoke-k1` for a real small PR in a sandbox repo.

## Suggested Build Order

1. Data model migration for `CodeChange`, richer task inputs/checkpoints, and delivery target
   write support.
2. Workspace manager and pinned sandbox toolchain image.
3. `github.submit_code_changes` with fake/local GitHub tests.
4. Merge webhook -> implementation task spawning with `plan_ref`, `base_sha`, and delivery
   targets.
5. Pi BUILD-stage runtime wiring: workspace lifecycle + sandboxed tools + verification loop.
6. Delivery fan-out to Slack thread and doc PR.
7. K1/K2 demos.
8. K3 iteration paths for doc PR comments, Slack replies, and code PR revisions.
9. K4 real resume with workspace diff snapshot/replay.
10. Forge YAML config and quickstart.
11. Status/cost built through the loop.
12. Only then revisit Proposed Effects, memory refactor, identity linking, M11, and Claude Code.

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
- `packages/tools/src/workspace.ts`
- `packages/tools/src/sandbox.ts`
- `packages/connector-github/src/client.ts`
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

The first proof is simpler and harder: Marathon must produce a real, reviewed, tested PR to
Marathon through its own loop.
