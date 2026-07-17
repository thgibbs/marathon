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

### 3. Replace the definition in config with a local import + re-export

`export { X } from "..."` is a **pure re-export**: it does not bind `X` into
the local module scope. `packages/config/src/index.ts` has other declarations
in the same file — `AgentSpec.on: KernelEvent[]`, `parseAgentSpec`'s `'on'`
validation, and `agentSubscribesTo` — that reference `KERNEL_EVENTS` and
`KernelEvent` as local names, not as `@marathon/config`-qualified names. A bare
re-export would leave those references unresolved and the file would not
compile.

So config must **import the symbols locally, then re-export the same
bindings**, in place of the deleted declarations:

```ts
import { KERNEL_EVENTS, type KernelEvent } from "@marathon/core";
export { KERNEL_EVENTS, type KernelEvent };
```

This is the exact resulting pattern: the `import` brings `KERNEL_EVENTS` and
`KernelEvent` into scope for every other declaration later in
`packages/config/src/index.ts` (`AgentSpec.on: KernelEvent[]`,
`parseAgentSpec`'s `'on'` validation, `agentSubscribesTo`, etc.) to keep
referencing them unqualified, exactly as before. The subsequent `export`
re-exports those same imported bindings, so `@marathon/config`'s public API
(`import { KERNEL_EVENTS, KernelEvent } from "@marathon/config"`) is
unchanged for existing consumers.

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
  churn for this change; the local import + re-export is a two-line change and
  keeps the diff small. Consolidating imports on `@marathon/core` can happen
  later if desired.
- **Bare `export { ... } from "@marathon/core"` re-export.** Rejected: it does
  not bind the names into `config/src/index.ts`'s local scope, so the file's
  own internal references to `KERNEL_EVENTS` / `KernelEvent` would fail to
  compile (flagged in review). The import-then-export pattern in step 3 fixes
  this.

## Non-goals

- Adding `stageInstructions` to `AgentVersion` (that is the follow-on doc).
- Any change to the event names, ordering, or the `on:` / `models.<event>`
  semantics.
- Touching other symbols in `config/src/index.ts`.

## Verification

Per `.marathon/config.yml`:

- `pnpm typecheck` — proves core compiles standalone with the new symbols, that
  `packages/config/src/index.ts` still compiles with the imported bindings in
  scope (`AgentSpec.on: KernelEvent[]`, `parseAgentSpec`, `agentSubscribesTo`),
  and that config's re-export type-checks; catches any accidental
  core→config cycle.
- `pnpm test` — the existing config suite
  (`packages/config/test/agent-spec.test.ts` et al.) exercises `KERNEL_EVENTS`
  through the config export and must stay green, demonstrating the re-export is
  transparent.
- **New: direct-from-core import check.** Since relocating these symbols makes
  `@marathon/core`'s export of `KERNEL_EVENTS` / `KernelEvent` a public API in
  its own right (not just an implementation detail behind config's re-export),
  verification must also exercise `import { KERNEL_EVENTS, type KernelEvent }
  from "@marathon/core"` directly — i.e. resolved through core's published
  entry point (`packages/core/package.json`'s `main`/`exports` field pointing
  at `packages/core/src/index.ts`'s barrel, the same barrel config now imports
  through), not only via the internal `./kernel-events` path. Add this as
  either a small type-only assertion file under `packages/core/test/` (e.g.
  asserting `KERNEL_EVENTS` is assignable from a direct `@marathon/core`
  import) or a case in an existing core test file, so `pnpm typecheck` /
  `pnpm test` fail if the barrel re-export (`export * from "./kernel-events"`
  in `packages/core/src/index.ts`) is ever dropped or the package's
  `main`/`exports` field stops pointing at it.

## Open questions

- Should the JSDoc block live in core (proposed) with config's re-export bare,
  or be duplicated? Proposal: single copy in core.
- Do we want to migrate existing `@marathon/config` importers of these symbols
  to `@marathon/core` now, or leave the re-export indefinitely? Proposal: leave
  it; migrate opportunistically to keep this PR minimal.
