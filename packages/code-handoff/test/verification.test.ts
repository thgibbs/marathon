import { describe, expect, it } from "vitest";
import {
  discoverVerifyCommands,
  isVerificationGreen,
  verifyCommandsFromConfig,
  verifyCommandsFromPlan,
} from "../src/verification";

const PLAN = `# Plan: add retry logic

Some intro.

## Verification

Run these:

\`\`\`sh
pnpm test
pnpm typecheck
\`\`\`

- also check \`make lint\`

## Rollout

- \`this is not verification\`
`;

describe("verifyCommandsFromConfig", () => {
  it("reads the verify: list from .marathon/config.yml", () => {
    expect(verifyCommandsFromConfig("verify:\n  - pnpm test\n  - make lint\n")).toEqual([
      "pnpm test",
      "make lint",
    ]);
  });

  it("tolerates malformed or unrelated yaml", () => {
    expect(verifyCommandsFromConfig(": not yaml [")).toEqual([]);
    expect(verifyCommandsFromConfig("other: true")).toEqual([]);
    expect(verifyCommandsFromConfig("verify: not-a-list")).toEqual([]);
  });
});

describe("verifyCommandsFromPlan", () => {
  it("extracts fenced commands and backticked bullets from the Verification section only", () => {
    expect(verifyCommandsFromPlan(PLAN)).toEqual(["pnpm test", "pnpm typecheck", "make lint"]);
  });

  it("returns empty when there is no Verification section", () => {
    expect(verifyCommandsFromPlan("# Plan\n\nNo section here.")).toEqual([]);
  });
});

describe("discoverVerifyCommands precedence (§29.3)", () => {
  const files = (map: Record<string, string>) => (path: string) => Promise.resolve(map[path] ?? null);

  it("repo config wins", async () => {
    const d = await discoverVerifyCommands({
      readFile: files({ ".marathon/config.yml": "verify:\n  - pnpm test\n", "docs/plan.md": PLAN }),
      planDocPath: "docs/plan.md",
    });
    expect(d).toEqual({ source: "repo_config", commands: ["pnpm test"] });
  });

  it("falls back to the plan's Verification section", async () => {
    const d = await discoverVerifyCommands({
      readFile: files({ "docs/plan.md": PLAN }),
      planDocPath: "docs/plan.md",
    });
    expect(d.source).toBe("plan_doc");
    expect(d.commands).toContain("pnpm test");
  });

  it("falls back to agent judgment when nothing declares commands", async () => {
    const d = await discoverVerifyCommands({ readFile: files({}), planDocPath: "docs/plan.md" });
    expect(d).toEqual({ source: "agent_judgment", commands: [] });
  });
});

describe("isVerificationGreen", () => {
  it("green requires at least one command, all exit 0", () => {
    expect(isVerificationGreen([])).toBe(false);
    expect(isVerificationGreen([{ command: "pnpm test", exitCode: 0, summary: "ok" }])).toBe(true);
    expect(
      isVerificationGreen([
        { command: "pnpm test", exitCode: 0, summary: "ok" },
        { command: "make lint", exitCode: 1, summary: "2 errors" },
      ]),
    ).toBe(false);
  });
});
