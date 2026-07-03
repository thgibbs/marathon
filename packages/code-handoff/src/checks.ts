/**
 * Deterministic §29.4 gateway checks: diff caps, protected-path refusal, secret
 * scan on added lines, and the enforced `marathon/` branch namespace. Pure
 * functions over the captured diff so they are unit-testable without git.
 */

export interface DiffCaps {
  maxFiles: number;
  maxChangedLines: number;
  maxBytes: number;
}

export const DEFAULT_DIFF_CAPS: DiffCaps = {
  maxFiles: 100,
  maxChangedLines: 5000,
  maxBytes: 1_000_000,
};

/** CI config runs with repo secrets — a privilege-escalation vector, refused by default (§29.4). */
export const DEFAULT_PROTECTED_PATHS = [".github/workflows/**"];

/**
 * Minimal glob matcher for protected-path patterns: `**` spans directories,
 * `*` matches within one path segment.
 */
export function isProtectedPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(
      "^" +
        pattern
          .split("**")
          .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
          .join(".*") +
        "$",
    );
    return re.test(path);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface DiffStats {
  files: string[];
  addedLines: AddedLine[];
  changedLineCount: number;
  bytes: number;
}

/** Parse a unified diff into the facts the checks need (files, added lines, size). */
export function parseDiff(diff: string): DiffStats {
  const files: string[] = [];
  const addedLines: AddedLine[] = [];
  let changedLineCount = 0;
  let currentFile = "";
  let newLineNo = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>` — take the b/ path (rename-safe enough for caps).
      const m = /^diff --git a\/.* b\/(.*)$/.exec(line);
      currentFile = m?.[1] ?? "";
      if (currentFile) files.push(currentFile);
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLineNo = m?.[1] ? Number(m[1]) : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push({ file: currentFile, line: newLineNo, text: line.slice(1) });
      changedLineCount++;
      newLineNo++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLineCount++;
    } else if (!line.startsWith("\\")) {
      newLineNo++;
    }
  }

  return { files, addedLines, changedLineCount, bytes: Buffer.byteLength(diff, "utf8") };
}

export interface SecretHit {
  file: string;
  line: number;
  /** Which pattern matched — never the matched text (§29.4: redacted pointer). */
  pattern: string;
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "github fine-grained token", re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws secret access key", re: /aws_secret_access_key\s*[:=]/i },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "openai api key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

/** Scan added lines for known secret patterns; returns redacted pointers only. */
export function scanAddedLinesForSecrets(added: AddedLine[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { file, line, text } of added) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file, line, pattern: name });
    }
  }
  return hits;
}

/**
 * The task's branch: `marathon/<task_id>-<slug>` (§29.5) — the `marathon/`
 * prefix is the gateway-enforced namespace; deterministic per task, so retries
 * and revisions converge on one branch (the slug is fixed at first submit via
 * the CodeChange record).
 */
export function branchForTask(taskId: string, title: string): string {
  const slug =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
  return `marathon/${taskId}-${slug}`;
}
