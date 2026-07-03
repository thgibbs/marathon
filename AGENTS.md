Read the overview in design/index.md to learn about the project. It also has links to other design documents that you can read as you need information.

RULES
1. Use typescript with strict mode enabled. Don't use the `any` type. No `as` assertions in
   domain/business logic — prefer proper narrowing (type guards, discriminated unions,
   `unknown` + validation). `as` is allowed only at trust boundaries where the type genuinely
   cannot be known statically, and each cast must sit next to the runtime check that justifies it:
   - Deserialization edges: database row mappers (e.g. the `rowTo*` functions in
     `packages/db`), parsed JSON/YAML payloads, and webhook payloads — one narrow,
     well-tested mapping function per shape.
   - Tool input narrowing in `execute()` functions, after the tool's `validate()` has run
     (tool inputs arrive as `Record<string, unknown>` by design).
   - Third-party interop where upstream types are missing or too loose (e.g. the
     dynamically-imported Pi module in `packages/agent`).
   - Tests: stubs and fixtures (e.g. `as never` for a fake secrets store) — blast radius is
     a test failure, not a production bug.
   - `as const` is always fine (it adds precision rather than removing checking).
2. Ensure all unit tests pass and that the code coverage is at least 90%.
3. When writing prose, use clear, precise, and concise language. Avoid jargon and explain any technical terms that may not be familiar to the reader.
