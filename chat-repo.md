# Chat-surface repo grounding — the static case

**Status:** implemented for the **Slack chat surface** (the canonical chat path,
which runs through `makeAgentTaskStepRunner`). The github-app mention/doc-draft
flow invokes the harness inline (not via the step runner), so grounding it is a
tracked follow-on — see [§9](#9-explicitly-deferred).
**Scope:** the *static* case only — a chat task materializes the repo its agent
is already bound to, gated by the invoking user's access and the task's
audience. The *dynamic* case (the model infers a repo mid-conversation and asks
for a workspace) is deliberately deferred — see [§9](#9-explicitly-deferred).

Related: `roadmap.md` §2b #17 (which stubbed this), §2b #10 (identity linking /
the per-user access checker), §2b #9 (the memory audience model),
`claude-code-impl.md` (the Claude Code harness), design §7.12 (audiences),
§7.20 (identity), §29.2 (workspace materialization).

---

## 1. Why

`withChatWorkspace` (shipped in §2b #17) gives every chat task an **empty**
ephemeral scratch directory. That was the minimum to make `harness:
claude-code` runnable on the chat surface — but an empty workspace is weak
grounding. The whole point of a code-capable harness answering in Slack is that
it can *see the code*. The §2b #17 roadmap text anticipated exactly this: "an
ephemeral scratch dir, **or** the configured repo checkout so grounding has
local files." This guide builds the second half.

**Static case, in one sentence:** when a chat task runs under an agent that has
a configured repo, and the invoking user may read that repo, and the task's
audience is not external, materialize a **read-only** checkout of that repo as
the task's workspace instead of the empty scratch dir.

Non-goals (this doc): the model choosing an arbitrary repo (dynamic case), a
channel→repo mapping table, writing/pushing from the chat sandbox, and
multi-repo agents. Those are [§9](#9-explicitly-deferred).

---

## 2. What already exists (the seams)

| Concern | Symbol / file | Notes |
| --- | --- | --- |
| Chat workspace stub | `withChatWorkspace(inner, { root })` — `packages/agent/src/chat-workspace.ts` | Binds an empty per-task scratch dir when `ctx.workspace` is unset. No-ops when a workspace is already present. |
| Materialization | `CodeWorkspace.materialize({ source, baseSha, prefix })` — `packages/code-handoff/src/workspace.ts` | Clones host-side, checks out `baseSha` **detached**, strips remotes + credential helpers, excludes `.marathon-home/`. Returns `{ dir, baseSha, dispose() }`. This is the BUILD path's primitive. |
| Brokered clone source | built at the live wiring site as `https://x-access-token:${token}@github.com/${repo}.git` — `demos/github-app/live.ts` | Host-side only; `materialize` strips it from `.git/config` after clone. Token from `secrets.get("secret/github")` (App installation token after §2b #15). |
| Per-user access check | `makeUserRepoAccessChecker(deps)` → `(tenantId, userId, repo) => "ok" \| "no_access" \| "no_link" \| "stale"` — `packages/github-app/src/identity.ts` | From §2b #10. Asks GitHub *as the user*; marks a dead link `stale`. |
| Audience | `audienceForTask(task)` → `TaskAudience { level, projectId, userId, external? }` — `packages/memory/src/project.ts` | Deterministic, no content classification. **Caveat:** Slack external/guest detection is **not wired** — `external` is only set when a caller knows. Slack channels are pseudo-projects (`slack:<channel>`), **not** linked to a repo. |
| Agent's repo | `spec.repo` ("owner/repo", §0.4) — `packages/config/src/index.ts` | One repo per agent. This is the static binding. |
| Chat step runner | `makeAgentTaskStepRunner(db, runtime, opts)` — `packages/worker/src/agent-step.ts` | Loads the task (has `sourceRef`, `invokingUserId`, `tenantId`, `agentId`), builds the prompt, calls `runtime.nextTurn({ request, checkpoint })` — **without** a workspace today. |
| Sandboxed read tools | `buildDockerSandboxTools` (`bash/read/write/edit/grep/find/ls`) — `packages/agent/src/sandbox-tools.ts` | §2b #2 routed these into the container, contained to the workspace. Relevant to the **Pi** chat path (see [§3.5](#35-harness-differences)). |

**Two facts that shape the design:**

1. **The workspace binding must exist *before* the turn starts.** Claude Code
   mounts `/workspace` when its container launches (`ClaudeCodeAgentRuntime`
   requires `ctx.workspace`). So "lazy per-message materialization" (clone only
   when the model reaches for a file mid-turn) is not possible for Claude Code —
   the decision is made once, per task, before `nextTurn`.

2. **The task has the context the runtime doesn't.** `withChatWorkspace` only
   sees `AgentTurnContext` (`request.taskId/tenantId/agentId`). The gate needs
   the task's `sourceRef` and `invokingUserId`. That context lives in the **step
   runner**, which already loads the task — so the workspace decision belongs
   there, not inside the agent runtime.

---

## 3. Design

### 3.1 The gate — when to ground, and on what

Grounding is decided per task, before the first turn, by a deterministic gate.
All four conditions must hold; otherwise the task falls back to the empty
scratch dir (Claude Code) or no workspace (Pi):

1. **Repo source.** `spec.repo` is set. (Static: the agent's one repo. No repo →
   no grounding.)
2. **Opt-in.** The agent opts in (`chat.ground_on_repo`, [§5](#5-configuration)),
   default *on* when a repo is configured.
3. **Per-user access.** `checkAccess(tenantId, invokingUserId, repo) === "ok"`
   (the §2b #10 checker). `no_link` / `stale` / `no_access` → **no repo**, and
   the task posts the `linkGithubCta()` note (`packages/slack-app/src/handlers.ts`)
   so the user can fix it. This bounds exposure to people who can actually read
   the repo.
4. **Audience × visibility.** This is the one condition that must **not** be
   written as `audience.external !== true` — `undefined !== true` is `true`, so
   an *unknown* audience would silently pass, which is exactly backwards for a
   private repo. Model it with two explicit, three-valued inputs:

   - `repoVisibility: "public" | "private"` — resolved from the GitHub client
     (`client.getRepo(repo)` returns `{ private }`), not assumed.
   - `audienceTrust: "internal_confirmed" | "external" | "unknown"` — derived
     from `audienceForTask(task)`: `external === true → "external"`; a
     positively-internal audience (a DM, or a channel an admin has marked
     internal) → `"internal_confirmed"`; **everything else → `"unknown"`**
     (Slack external/guest detection isn't wired yet — [§3.6](#36-security-model)).

   The rule (deny-by-default):

   | repoVisibility | audienceTrust | ground? |
   | --- | --- | --- |
   | public | any | yes (audience is moot — the code is already public) |
   | private | `internal_confirmed` | yes |
   | private | `unknown` | **no** |
   | private | `external` | **no** |

   A materialized checkout is a *source* in the egress ledger (§7.8); pulling a
   private repo into a task whose readers you cannot positively confirm are all
   internal is a data-exposure event, so `unknown` is treated exactly like
   `external`. See [§3.6](#36-security-model).

The gate is **deny-by-default in the strict sense**: it grounds only when every
condition is *positively* satisfied — an unresolved repo visibility, an
unconfirmed audience, or an unavailable access check all fall to no grounding.
It never fails the task — grounding is an enhancement, so a denied gate degrades
to today's behavior plus (for the access case) a user-facing hint.

### 3.2 Placement — the step runner owns it, the provider is injected

The decision moves up to `makeAgentTaskStepRunner`, which has the task. Add an
injected policy:

```ts
// packages/worker/src/agent-step.ts — AgentTaskStepOptions
resolveWorkspace?: (task: Task) => Promise<ResolvedChatWorkspace | undefined>;
```

The result is a **first-class disposable**, not a binding with a structurally
bolted-on `dispose` (P2). `ResolvedChatWorkspace` pairs the binding with an
explicit teardown, so the lifecycle contract is in the type:

```ts
// packages/worker/src/chat-workspace-provider.ts
export interface ResolvedChatWorkspace {
  /** { dir, baseSha: <the exact resolved commit sha> } — see §3.3 pinning. */
  workspace: AgentWorkspaceBinding;
  /** Tears down the checkout. Always called in the step runner's finally. */
  dispose(): Promise<void>;
}
```

The step runner calls it and threads the binding into the turn:

```ts
const resolved = opts.resolveWorkspace ? await opts.resolveWorkspace(task) : undefined;
try {
  const turn = await runtime.nextTurn({ request, checkpoint, workspace: resolved?.workspace });
  // …
} finally {
  await resolved?.dispose();
}
```

`withChatWorkspace` stays as the **fallback**: it already no-ops when
`ctx.workspace` is set, so a resolved repo workspace passes through, and an
unresolved one still gets the scratch dir for Claude Code. The two compose
cleanly — no double-binding.

**Layering.** `@marathon/agent` must not depend on `@marathon/github-app`
(access checker) or reach into `@marathon/memory`'s audience beyond what
`@marathon/worker` already imports. So the *provider* is composed at the **live
wiring site** (`packages/slack-app/src/app.ts`, `demos/github-app/live.ts`) from
injected pieces, and a small factory in `@marathon/worker` wires them:

```ts
// packages/worker/src/chat-workspace-provider.ts  (new)
export interface ChatWorkspaceProviderDeps {
  repo?: string;                                   // spec.repo
  enabled: boolean;                                // chat.ground_on_repo
  source: (repo: string) => string | Promise<string>; // brokered clone URL, host-side
  checkAccess: (tenantId: string, userId: string, repo: string)
    => Promise<"ok" | "no_access" | "no_link" | "stale">;
  /** Resolve repo visibility for the audience×visibility rule (§3.1 cond. 4). */
  repoVisibility: (repo: string) => Promise<"public" | "private">;
  /**
   * Audience trust for `task`. Wraps `audienceForTask` but collapses to three
   * values: an unset/uncertain `external` becomes "unknown" (never a silent
   * pass). "internal_confirmed" requires a DM or an admin-marked-internal channel.
   */
  audienceTrust: (task: Task) => "internal_confirmed" | "external" | "unknown";
  /** Shallow read-only clone at the resolved head; returns the binding, its sha, and dispose. */
  materialize: (source: string) => Promise<ResolvedChatWorkspace>;
  /**
   * Emitted once per (task, reason) — the provider dedupes via `db.claim`
   * so a multi-turn/retry task never re-spams the same CTA (P2, §7).
   */
  onDenied?: (task: Task, reason: "no_link" | "stale" | "no_access") => void | Promise<void>;
}
export function makeRepoChatWorkspaceProvider(deps: ChatWorkspaceProviderDeps):
  (task: Task) => Promise<ResolvedChatWorkspace | undefined>;
```

`@marathon/worker` may import `audienceForTask` from `@marathon/memory` (it
already depends on it), so the audience derivation lives inside the factory. The
`checkAccess` and `repoVisibility` functions are passed in from the live app
(built from github-app's `makeUserRepoAccessChecker` and the `GithubClient`),
keeping the package graph acyclic.

### 3.3 Lifecycle — materialize per turn, dispose per turn

Follow the BUILD path's turn-atomicity contract (§11.2: "containers are never
recovered — always re-provision + re-materialize"). The chat workspace is
**materialized fresh at the start of each turn and disposed at the end**:

- No long-lived clone survives a multi-day durable wait (§11.6) — nothing to
  leak, nothing to sweep.
- A resume re-materializes, exactly like BUILD. The harness session (the
  JSONL under the writable home — [§3.4](#34-read-only-and-the-build-boundary))
  is carried by the existing K4 snapshot/restore, independent of the workspace
  contents.
- Cost is bounded by a **warm-clone cache** keyed by `(repo, sha)`: the first
  materialization does a shallow clone (`git clone --depth 1`), later ones copy
  from the warm bare cache.

**Pin the SHA, don't drift (P2).** "Shallow clone of the default branch" is not
the same as "no version." Resolve the **exact commit sha** at materialization
and record it, so multi-turn tasks are reproducible and the checkout is
attributable:

- `materializeReadonly` resolves the head sha (`git rev-parse HEAD` after the
  shallow clone, or `client.getRef("heads/<default>")` before it) and returns it
  as `workspace.baseSha`.
- Record the sha as a **source in the ledger / audit trail** (§7.8) — the same
  `InMemorySourceLedger`/audit path the gateway uses — so "the agent read
  `acme/widgets` at `<sha>`" is inspectable.
- **Pin the task to the first resolved sha.** The first turn stashes the sha on
  the task checkpoint; resumes materialize *that* sha, not whatever `main` moved
  to since. A conversation reasons about one consistent tree across its turns.
  "Latest each turn" is available as an explicit `chat.ground_ref: latest`
  opt-out ([§5](#5-configuration)) — a deliberate product choice, not the
  silent default.

Concretely, add a read-only sibling to `materialize` so chat grounding doesn't
carry the diff/commit machinery, and have it surface the resolved sha:

```ts
// packages/code-handoff/src/workspace.ts
static async materializeReadonly(opts: { source: string; ref?: string; prefix?: string })
  : Promise<{ workspace: CodeWorkspace; sha: string }>;
  // shallow clone at `ref` (default branch when omitted), remotes + credential
  // helpers stripped; `sha` is the exact resolved commit — the caller pins/records it.
```

Dispose in the step runner's `finally`, every turn, via the first-class
`ResolvedChatWorkspace.dispose` ([§3.2](#32-placement--the-step-runner-owns-it-the-provider-is-injected)):

```ts
const resolved = await opts.resolveWorkspace?.(task);
try { /* nextTurn with resolved?.workspace */ } finally { await resolved?.dispose(); }
```

### 3.4 Read-only, and the BUILD boundary

Chat grounding is strictly **read**, and "read-only" has to be enforced by
**construction**, not by a denylist (P1). Denying `Write`/`Edit` alone does
nothing if `bash`/shell or any other file-capable tool is present — the model
could `echo > file`, `git apply`, or read outside the tree via a shell. Two
independent guards, both required:

1. **Mount the checkout read-only.** The container's `/workspace` bind mount is
   `:ro`. This is the floor: even a shell couldn't write the tree. It needs a
   small sandbox-factory change — `workspaceContainerOptions` /
   `workspaceSandboxFromSpec` gain a `readonlyWorkspace` flag that adds `,ro` to
   the mount. **Writable-home wrinkle:** the harness session/config lives under
   `.marathon-home` inside the mount today (BUILD's `HOME=/workspace/.marathon-home`).
   With `/workspace` read-only that path can't be written, so for chat grounding
   the home is a **separate writable mount** — a tmpfs or host scratch dir
   mounted at the home path (or `HOME` relocated to a writable `/home/marathon`).
   The repo is read-only; the harness's own scratch/session is writable and
   ephemeral.
2. **Expose only a read-only tool surface.** No `bash`/shell, no
   `write`/`edit`, and none of the code-handoff tools (`github.exec`, `git.exec`,
   `submit_code_changes`, `delivery.report_pr`) are registered for a chat task.
   Claude Code gets its file tools constrained to the read set and shell denied
   (`disallowedTools` includes `Bash`); Pi chat gets only the read-only subset
   of `buildDockerSandboxTools` ([§3.5](#35-harness-differences)). The chat tool
   set is asserted to be a subset of an explicit read-only allowlist
   (`read`/`grep`/`find`/`ls` + the governed read tools) — [§6](#6-testing).

The materialized workspace is never diffed or pushed. If a conversation turns
into "make this change," that is a **BUILD task**, which already has the right
shape: a design-doc PR, merge as approval, then a pinned-base workspace and a
code PR (§29). The chat sandbox is for *understanding*, the BUILD sandbox is for
*changing* — keep them distinct, and enforced by the read-only mount + tool
surface, so an unreviewed chat turn *cannot* land code even if the model tries.

### 3.5 Harness differences

The same `AgentWorkspaceBinding` grounds both harnesses, but they consume it
differently:

- **Claude Code (primary beneficiary).** Runs inside the container with
  `/workspace` mounted **read-only** ([§3.4](#34-read-only-and-the-build-boundary));
  it reads files directly with its built-in tools. The moment the binding points
  at a real checkout, grounding is real. Constrain the tool surface: deny
  `Write`/`Edit` **and `Bash`** via `disallowedTools` (the §2b #17 wiring already
  passes `disallowedTools`), so read-only isn't relying on the mount alone.
- **Pi chat.** Today Pi chat runs **containerless with governed tools only** —
  no filesystem tools. To ground Pi chat on the checkout you additionally need
  to give it the sandbox + the **read-only** subset of the §2b #2 tools
  (`read`/`grep`/`find`/`ls`, *not* `bash`/`write`/`edit`) pointed at the
  materialized workspace. That is an incremental follow-on; it reuses
  `buildDockerSandboxTools` with a read-only tool list. Until then, a Pi chat
  agent gets the workspace binding but no way to read it — so **enable static
  grounding for `harness: claude-code` first**, and treat Pi chat grounding as a
  fast-follow.

### 3.6 Security model

Grounding pulls repository contents into an execution environment, so it is
governed by the same boundaries as every other data movement:

- **Credential handling** is unchanged from BUILD: the clone token is injected
  host-side into the clone URL and **stripped from `.git/config`** by
  `materialize` before the dir is mounted; the sandbox never sees it, and it
  never enters the prompt or trace (§29.2). After §2b #15 the token is a
  short-lived App installation token.
- **Per-user access gate** (condition 3): only repos the invoking user can
  actually read are pulled in — the §2b #10 checker asks GitHub *as them*. This
  bounds the *invoking* user; it does **not** bound the channel's other readers,
  which is why the audience gate is separate and independent.
- **Audience × visibility gate** (condition 4) is the sharp edge, and the
  **known gap** is why it's modeled with an explicit three-valued `audienceTrust`
  (§3.1): Slack external/guest detection is not wired (`audienceForTask` leaves
  `external` unset for channels), so an unconfirmed audience is `"unknown"` and
  **treated exactly like `external`** for a private repo — never a silent pass.
  Practical consequence for v1: **public repos ground anywhere; private repos
  ground only in `internal_confirmed` audiences** (DMs, or channels an admin has
  marked internal). That's the conservative shape until Slack external-member
  flags land (the §2b #9 follow-on) and can promote channels to
  `internal_confirmed` automatically.
- **Read-only by construction** (§3.4): the checkout is mounted `:ro` **and**
  the chat task exposes only a read-only tool surface (no shell, no write/edit,
  no code-handoff tools) — the mount and the tool set each independently prevent
  mutation or a push-based exfil, so neither is the single point of failure.

---

## 4. Implementation guide

Ordered, each step independently testable.

1. **`materializeReadonly`** — `packages/code-handoff/src/workspace.ts`.
   Shallow clone (`--depth 1`) at `ref` (default branch when omitted), strip
   remotes + credential helpers (reuse the existing strip), **resolve and return
   the exact head sha** (`git rev-parse HEAD`). Returns `{ workspace, sha }` and
   keeps `dispose()`. Unit-test: clone a local fixture repo, assert files
   present, remotes/creds stripped, the returned `sha` equals the fixture's HEAD,
   `dispose` removes the dir.

2. **Warm-clone cache** (optional) — a module keyed by `(repo, sha)` that keeps
   a bare mirror and serves shallow working copies. Skippable in v1 (plain
   shallow clone per turn); add when clone latency shows up. Behind the same
   `materializeReadonly` call site so it's a drop-in.

3. **`makeRepoChatWorkspaceProvider`** — new
   `packages/worker/src/chat-workspace-provider.ts` (exported from the package
   index). Implements the [§3.1](#31-the-gate--when-to-ground-and-on-what) gate
   in order, deny-by-default: repo present → enabled → `checkAccess === "ok"`
   (else `onDenied` once, [step 7](#4-implementation-guide)) → compute
   `repoVisibility` × `audienceTrust` and apply the table (public: any;
   private: `internal_confirmed` only; `unknown`/`external` private → deny) →
   `materializeReadonly` → **pin/record the sha** (stash on the task checkpoint
   on turn 0, record in the source ledger/audit) → return `ResolvedChatWorkspace`;
   otherwise `undefined`. Unit-test every branch: repo/no-repo, opt-out,
   `ok`/`no_link`/`stale`/`no_access`, and the **full visibility×trust matrix**
   (public+unknown → ground, private+unknown → deny, private+internal_confirmed →
   ground, private+external → deny) with fakes for `checkAccess`,
   `repoVisibility`, `audienceTrust`, and `materialize`.

4. **First-class disposable + SHA pinning types** — add `ResolvedChatWorkspace`
   ([§3.2](#32-placement--the-step-runner-owns-it-the-provider-is-injected)) and
   the `chat.ground_ref` handling (pin first sha vs. `latest`). No structural
   `dispose`; the checkpoint field holds the pinned sha across resumes.

5. **Thread `resolveWorkspace` through the step runner** —
   `packages/worker/src/agent-step.ts`: add the option, call it before
   `nextTurn`, pass `resolved.workspace` into the turn, `await resolved.dispose()`
   in `finally`. Unit-test: a provider returning a `ResolvedChatWorkspace` →
   `nextTurn` receives the binding and `dispose` is called exactly once (even on
   a thrown turn); `undefined` → `nextTurn` gets no workspace and no dispose.

6. **Read-only enforcement** ([§3.4](#34-read-only-and-the-build-boundary)) —
   two parts:
   - `workspaceContainerOptions` / `workspaceSandboxFromSpec`
     (`packages/agent/src/sandbox-factory.ts`) gain a `readonlyWorkspace` flag
     that mounts `/workspace` `:ro` and mounts a **separate writable** home
     (tmpfs/scratch) for the harness session/config. Unit-test the emitted
     `docker run` args (`,ro` on the workspace mount, a writable home mount).
   - The chat tool set for a grounded task is the read-only allowlist only
     (`read`/`grep`/`find`/`ls` + governed read tools); assert no `bash`, no
     `write`/`edit`, no `github.exec`/`git.exec`/`submit_code_changes`/
     `delivery.report_pr`. For Claude Code, `disallowedTools` includes `Bash`,
     `Write`, `Edit`.

7. **Denial idempotency** ([§7](#7-failure-modes--user-facing-messaging)) — the
   provider emits `onDenied` at most once per `(task, reason)`, deduped via
   `db.claim("chat:ground-denial:<taskId>:<reason>")` (the existing idempotency
   primitive). Unit-test: three resolves of the same denied task → one `onDenied`.

8. **Wire the live apps** — `packages/slack-app/src/app.ts` and
   `demos/github-app/live.ts`:
   - Build `checkAccess` from `makeUserRepoAccessChecker`; when identity linking
     isn't configured, pass a checker that returns `"no_link"` so grounding
     degrades safely.
   - `repoVisibility: (repo) => (await client.getRepo(repo))?.private ? "private" : "public"`.
   - `audienceTrust`: DM → `internal_confirmed`; admin-marked-internal channel →
     `internal_confirmed`; else `"unknown"` (until §2b #9 external flags land).
   - `source: (repo) => https://x-access-token:${await secrets.get("secret/github")}@github.com/${repo}.git`.
   - `onDenied`: post `linkGithubCta()` in-thread for `no_link`/`stale` (deduped
     by step 7).
   - Pass the provider as `resolveWorkspace` into `makeAgentTaskStepRunner`; set
     `readonlyWorkspace` on the sandbox factory for chat tasks.
   - Guard: only enable for `harness: claude-code` in v1 (Pi chat has no read
     tools yet — [§3.5](#35-harness-differences)).

9. **(Fast-follow, separate change) Pi chat read tools** — register the
   read-only subset of `buildDockerSandboxTools` for Pi chat tasks that have a
   workspace, so Pi chat can also read the checkout. Not required for the
   Claude-Code-first v1.

---

## 5. Configuration

Add an opt-in to the agent spec (`packages/config/src/index.ts`,
`parseAgentSpec`), defaulting *on* when a repo is set:

```yaml
# agents/forge.yaml
repo: acme/widgets
chat:
  ground_on_repo: true    # default: true when `repo` is set; false disables static grounding
  ground_ref: pinned      # pinned (default) = pin the first resolved sha for the task;
                          # latest = re-resolve HEAD each turn (deliberate opt-out, §3.3)
```

- `AgentSpec.chat?: { groundOnRepo: boolean; groundRef: "pinned" | "latest" }`,
  `groundOnRepo` resolved to `true` iff `spec.repo` is set and the field isn't
  explicitly `false`; `groundRef` default `"pinned"`.
- No new env var is required — the clone source, visibility lookup, and access
  checker all come from existing config (`secret/github`, the `GithubClient`,
  the §2b #10 identity deps).

Startup log (per §2b #13 style): state whether chat grounding is active and on
which repo, so a misconfigured gate is visible — e.g.
`[slack-app] chat grounding: acme/widgets (claude-code, read-only)` vs
`[slack-app] chat grounding: off (no repo configured)`.

---

## 6. Testing

- **Unit (worker):** the provider gate — every branch of [§3.1](#31-the-gate--when-to-ground-and-on-what):
  repo/no-repo, opt-out, access `ok`/`no_link`/`stale`/`no_access`, and the
  **full visibility × trust matrix** (public+unknown → ground; private+unknown →
  deny; private+internal_confirmed → ground; private+external → deny — asserting
  `undefined !== true` can't sneak a private repo through). Plus **denial
  idempotency** (three resolves of a denied task → one `onDenied`) and **sha
  pinning** (turn 0 stashes the sha; a resume materializes that sha, not a moved
  HEAD). Fakes for `checkAccess`, `repoVisibility`, `audienceTrust`,
  `materialize`; no Docker, no network.
- **Unit (code-handoff):** `materializeReadonly` against a local fixture repo —
  files present, remotes/creds stripped, the returned `sha` equals the fixture
  HEAD, `dispose` removes the dir.
- **Unit (agent-step):** `resolveWorkspace` threading + `dispose` called exactly
  once (including on a thrown turn) via the first-class `ResolvedChatWorkspace`.
- **Unit (sandbox-factory):** `readonlyWorkspace` → the `docker run` args carry
  `,ro` on the `/workspace` mount **and** a separate writable home mount.
- **Unit (read-only tool surface):** a grounded chat task's tool set ⊆ the
  read-only allowlist — assert **no `bash`, no `write`/`edit`, no
  `github.exec`/`git.exec`/`submit_code_changes`/`delivery.report_pr`** (not just
  "no `submit_code_changes`").
- **Automated demo (deterministic, CI):** extend the slack demo — a chat task
  under a repo-bound agent, fake `checkAccess("ok")` + `repoVisibility("public")`
  → assert `nextTurn` received a workspace whose dir contains the fixture repo
  and whose `baseSha` is the fixture HEAD; a **private repo + unknown audience**
  → assert **no workspace**; a `no_link` user → assert no workspace + exactly one
  CTA note across two turns. Fake materialize (local fixture) → Docker-free.
- **Live smoke (real services, local):** ask in a channel bound to a real
  **public** repo with `harness: claude-code` → Claude reads a real file from the
  read-only checkout in its answer, and a `bash` attempt is refused. This is the
  smoke the §2b #17 chat path never got — it doubles as the missing end-to-end
  proof.

---

## 7. Failure modes & user-facing messaging

| Situation | Behavior |
| --- | --- |
| No repo configured | No workspace; scratch dir (Claude Code) / none (Pi). Silent — normal. |
| User not linked (`no_link`) / link `stale` | No workspace; reply includes `linkGithubCta()` ("Run `/marathon link github` …") — the §2b #10 denial-CTA entry point, finally with a real consumer. **Emitted once per `(task, reason)`** (`db.claim` dedupe), so a retry/resume/follow-up on the same task never re-spams the prompt (P2). |
| User lacks repo access (`no_access`) | No workspace; a brief "I can't ground on `<repo>` for you — you don't appear to have access" note, **also once per task**. |
| Private repo + `unknown` or `external` audience | No workspace; silent (or an admin-facing log). Never leak private code — `unknown` is treated like `external` (§3.1). |
| Clone fails (network, gone repo) | No workspace; log + degrade to ungrounded, never fail the task. |

Grounding is always **best-effort**: every failure degrades to today's
ungrounded behavior. The task still answers. Denial notices are **idempotent per
task and reason** — the provider only surfaces a given CTA the first time a task
hits that wall, not on every turn.

---

## 8. Why this shape (rationale)

- **Step runner, not runtime, owns the decision** because that's where the task
  context lives, and it keeps `@marathon/agent` free of github-app/memory deps.
- **Per-turn materialize + dispose**, via a **first-class `ResolvedChatWorkspace`**
  (not a structurally bolted-on `dispose`), because it matches the existing §11.2
  turn-atomicity contract, puts teardown in the type, needs no lifecycle sweeper,
  and can't leak clones across multi-day waits.
- **Explicit `repoVisibility` × `audienceTrust`, deny-by-default in the strict
  sense** — not `external !== true`, which lets an *unknown* audience slip a
  private repo through. `unknown` is treated as `external`; grounding kicks in
  only when access **and** audience are *positively* clear.
- **Read-only by construction** — a `:ro` mount **and** a read-only tool surface
  (no shell), so neither the mount nor the denylist is a single point of failure.
- **Pin the SHA** so a multi-turn conversation reasons about one consistent tree,
  and the checkout is attributable in the source ledger; "latest each turn" is an
  explicit opt-out, never the silent default.
- **Claude Code first** because it consumes the workspace with zero extra work;
  Pi chat needs the read-tool follow-on, so it shouldn't block v1.

---

## 9. Explicitly deferred

- **Dynamic case** (the model infers a repo and requests a workspace). This is
  strictly more powerful and more dangerous: the model is influenced by
  untrusted channel content, so a `provision_workspace(repo)` tool must clone
  only *within* the allowlist the user + audience already grant — it can't
  expand it. That is an M10 proposed-effect shape and should land **after** the
  egress/audience gating is fully wired, not before.
- **Channel→repo mapping table** (a channel bound to a repo other than the
  agent's, or an agent serving several repos). The static case uses the agent's
  one `repo`; a mapping is a small table + resolver on top, once there's demand.
- **Slack external/guest detection** — the audience gap in [§3.6](#36-security-model).
  Until shared-channel/guest flags feed `audienceForTask.external`, a Slack
  channel resolves to `audienceTrust: "unknown"` unless an admin marked it
  internal, so private-repo grounding is restricted to DMs + admin-marked-internal
  channels (public repos are unaffected). When the flags land they can promote a
  clean channel to `internal_confirmed` automatically. This is the §2b #9
  follow-on.
- **Pi chat read tools** — [§4](#4-implementation-guide) step 9; a fast-follow,
  not part of the Claude-Code-first v1.
- **github-app mention/doc-draft grounding** — the Slack surface is wired (it
  runs through `makeAgentTaskStepRunner`, where the `resolveWorkspace` seam
  lives). The github-app mention flow calls `runtime.nextTurn` inline in
  `handlers.ts`, so grounding it means either routing those tasks through the
  step runner or threading a workspace through the handler. A follow-on; the
  provider (`makeRepoChatWorkspaceProvider`) is surface-agnostic and reused as-is.
- **Write from chat** — never. Changes go through the BUILD path
  (merge-as-approval, §29).
