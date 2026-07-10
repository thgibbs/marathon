# Move `KERNEL_EVENTS` / `KernelEvent` to `@marathon/core`, config re-exports

**Status:** proposed · **Scope:** one-symbol relocation + re-export shim ·
**Type:** prerequisite refactor (unblocks the `AgentVersion.stageInstructions` proposal)

## Why this doc exists

A design under review proposes adding a per-stage instructions field —
`stageInstructions` — to the **core** `AgentVersion` type, keyed by the kernel
loop event (`draft` / `design-review` / `build` / `code-review`). That keying
needs the `KernelEvent` type. But `KernelEvent` (and its backing const
`KERNEL_EVENTS`) live today in **`@marathon/config`**, not core:

- `packages/config/src/index.ts` — the `KERNEL_EVENTS` const + `KernelEvent`
  type (around lines 198–199; line numbers drift, the symbols are the anchor):

  ```ts
  export const KERNEL_EVENTS = ["draft", "design-review", "build", "code-review"] as const;
  export type KernelEvent = (typeof KERNEL_EVENTS)[number];
  ```

The two packages have **no dependency edge in either direction**:

- `@marathon/core` (`packages/core/package.json`) declares **no dependencies at all**.
- `@marathon/config` (`packages/config/package.json`) depends only on `yaml`.

So core cannot reference `KernelEvent` as written — it would have to import from
config, and there is no such dependency. This blocks implementation step 2 of
the `stageInstructions` doc immediately. This doc resolves it with the
one-sentence fix raised in review: **move `KERNEL_EVENTS` / `KernelEvent` down
into core, and have config re-export them** so every existing importer keeps
working unchanged.

## Why core is the right home (not "core depends on config")

There are two ways to make the symbols visible to core:

1. **core → config** — give core a dependency on config so it can import
   `KernelEvent`.
2. **Move the symbols into core; config re-exports** — this proposal.

Option 1 inverts the natural layering. `@marathon/core` is the foundational,
dependency-free domain-types package ("Core domain types, aligned with
design.md §10" — `packages/core/src/entities.ts`); it is imported *by* many
packages. `@marathon/config` is a higher layer that reads YAML and loads runtime
configuration. Making the foundation depend on a higher layer is the wrong
direction and would put a `yaml`-carrying package underneath core.

The kernel events are a **domain concept** — the four canonical stages of the
kernel loop — not a configuration-loading concern. They arguably belonged in
core from the start; config only owns them incidentally because `AgentSpec.on`
was defined there. Relocating them to core is a layering *improvement*, and the
re-export means no consumer has to change.

The resulting edge is `config → core` (config re-exports from core), which is
acyclic: core imports nothing from config.

## Proposed change

### 1. Add the symbols to `@marathon/core`

New file `packages/core/src/kernel-events.ts` (carrying the existing JSDoc verbatim):

```ts
/**
 * The four canonical kernel-loop events (codex-impl.md §A.3): something that
 * happened and needs a response. `on:` in an agent's YAML names which of
 * these it subscribes to; `models.<event>` routes that event to its own model.
 */
export const KERNEL_EVENTS = ["draft", "design-review", "build", "code-review"] as const;
export type KernelEvent = (typeof KERNEL_EVENTS)[number];
```

Re-export it from `packages/core/src/index.ts` alongside the other barrels:

```ts
export * from "./kernel-events";
```

### 2. Point `@marathon/config` at core

Add the workspace dependency in `packages/config/package.json`:

```json
"dependencies": {
  "@marathon/core": "workspace:*",
  "yaml": "^2.9.0"
}
```

### 3. Replace the definition in config with a re-export

In `packages/config/src/index.ts`, delete the `KERNEL_EVENTS` / `KernelEvent`
declarations and re-export from core in the same spot, preserving the public API:

```ts
export { KERNEL_EVENTS, type KernelEvent } from "@marathon/core";
```

Everything else in config that uses these symbols continues to work unchanged,
because they resolve to the same values via the re-export — including
`AgentSpec.on: KernelEvent[]`, `parseAgentSpec`'s `'on'` validation, and
`agentSubscribesTo`, all in the same file.

### 4. (Enables the follow-on doc) `AgentVersion` can now key on `KernelEvent`

With `KernelEvent` in core, the `stageInstructions` proposal's field type
resolves in-package — e.g. `stageInstructions?: Partial<Record<KernelEvent, string>>`
on `AgentVersion` in `packages/core/src/entities.ts`. **Adding the field itself
is out of scope for this doc** — it lands in the `stageInstructions` PR; this
doc only removes the dependency-layering blocker so that PR's step 2 compiles.

## Backward compatibility

- **Public API of `@marathon/config` is unchanged.** `KERNEL_EVENTS` and
  `KernelEvent` remain named exports of `@marathon/config`; only their
  definition site moves. `import { KERNEL_EVENTS, KernelEvent } from "@marathon/config"`
  keeps resolving — existing consumers (e.g. `packages/config/test/agent-spec.test.ts`)
  need no edits.
- New consumers (core, and anything already depending on core) can import the
  symbols directly from `@marathon/core`.
- No runtime/values change: same array, same order, same string literals.

## Alternatives considered

- **core → config dependency.** Rejected: inverts layering and drags `yaml`
  under the foundational types package (see above).
- **Duplicate the const in core.** Rejected: two sources of truth for the
  canonical event list invites drift; the whole point of `KERNEL_EVENTS` as a
  single `as const` is that `on:` validation and routing agree.
- **Drop the config export, update all importers.** Rejected as unnecessary
  churn for this change; the re-export is a one-liner and keeps the diff small.
  Consolidating imports on `@marathon/core` can happen later if desired.

## Non-goals

- Adding `stageInstructions` to `AgentVersion` (that is the follow-on doc).
- Any change to the event names, ordering, or the `on:` / `models.<event>`
  semantics.
- Touching other symbols in `config/src/index.ts`.

## Verification

Per `.marathon/config.yml`:

- `pnpm typecheck` — proves core compiles standalone with the new symbols and
  that config's re-export type-checks; catches any accidental core→config cycle.
- `pnpm test` — the existing config suite
  (`packages/config/test/agent-spec.test.ts` et al.) exercises `KERNEL_EVENTS`
  through the config export and must stay green, demonstrating the re-export is
  transparent.

## Open questions

- Should the JSDoc block live in core (proposed) with config's re-export bare,
  or be duplicated? Proposal: single copy in core.
- Do we want to migrate existing `@marathon/config` importers of these symbols
  to `@marathon/core` now, or leave the re-export indefinitely? Proposal: leave
  it; migrate opportunistically to keep this PR minimal.
