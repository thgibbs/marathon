import { describe, expect, it } from "vitest";
import {
  branchForTask,
  DEFAULT_PROTECTED_PATHS,
  isProtectedPath,
  parseDiff,
  scanAddedLinesForSecrets,
} from "../src/checks";

const SAMPLE_DIFF = `diff --git a/app.ts b/app.ts
index 111..222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,3 @@
 export const x = 1;
-export const y = 2;
+export const y = 3;
+export const z = 4;
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const n = 1;
`;

describe("parseDiff", () => {
  it("extracts files, added lines with positions, and change counts", () => {
    const stats = parseDiff(SAMPLE_DIFF);
    expect(stats.files).toEqual(["app.ts", "src/new.ts"]);
    expect(stats.changedLineCount).toBe(4); // 3 added + 1 removed
    expect(stats.addedLines.map((l) => `${l.file}:${l.line}`)).toEqual([
      "app.ts:2",
      "app.ts:3",
      "src/new.ts:1",
    ]);
    expect(stats.addedLines[0]?.text).toBe("export const y = 3;");
  });
});

describe("isProtectedPath", () => {
  it("refuses .github/workflows/** by default (CI runs with repo secrets)", () => {
    expect(isProtectedPath(".github/workflows/ci.yml", DEFAULT_PROTECTED_PATHS)).toBe(true);
    expect(isProtectedPath(".github/workflows/deep/nested.yml", DEFAULT_PROTECTED_PATHS)).toBe(true);
    expect(isProtectedPath(".github/CODEOWNERS", DEFAULT_PROTECTED_PATHS)).toBe(false);
    expect(isProtectedPath("src/app.ts", DEFAULT_PROTECTED_PATHS)).toBe(false);
  });

  it("supports tenant-configured single-segment globs", () => {
    expect(isProtectedPath("infra/prod.tf", ["infra/*.tf"])).toBe(true);
    expect(isProtectedPath("infra/modules/vpc.tf", ["infra/*.tf"])).toBe(false);
    expect(isProtectedPath("infra/modules/vpc.tf", ["infra/**"])).toBe(true);
  });
});

describe("scanAddedLinesForSecrets", () => {
  it("flags known token shapes with a redacted pointer (never the text)", () => {
    const hits = scanAddedLinesForSecrets([
      { file: "config.ts", line: 3, text: `const token = "ghp_${"a".repeat(36)}";` },
      { file: "deploy.sh", line: 9, text: "aws_secret_access_key = whatever" },
      { file: "key.pem", line: 1, text: "-----BEGIN RSA PRIVATE KEY-----" },
      { file: "ok.ts", line: 1, text: "const safe = 42;" },
    ]);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["config.ts:3", "deploy.sh:9", "key.pem:1"]);
    for (const h of hits) {
      expect(JSON.stringify(h)).not.toContain("ghp_");
    }
  });
});

describe("branchForTask", () => {
  it("builds marathon/<task>-<slug>, deterministic and namespace-enforced", () => {
    expect(branchForTask("task-1", "Add retry logic!")).toBe("marathon/task-1-add-retry-logic");
    expect(branchForTask("task-1", "Add retry logic!")).toBe(branchForTask("task-1", "Add retry logic!"));
    expect(branchForTask("task-1", "///")).toBe("marathon/task-1-change");
  });
});
