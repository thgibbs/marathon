import { CodeHandoffError } from "@marathon/code-handoff";
import {
  capOutput,
  describeFamilies,
  ExecFileCommandRunner,
  flagValue,
  matchCommandFamily,
  type CommandFamily,
  type CommandRunner,
  type EgressTarget,
  type SourceRead,
  type Tool,
  type ToolInput,
} from "@marathon/tools";

/**
 * The credentialed `gh`/`git` broker (code-migration.md Track 6). The agent
 * drives normal GitHub workflows — `gh pr view`, `git push` — instead of custom
 * semantic tools; Marathon injects the credential into the brokered child
 * process only. The credential never appears in the argv, the sandbox, the
 * recorded trace, or the model-visible result.
 *
 * Policy is an allowlist of explicit command families plus a repo allowlist,
 * not a policy language. GitHub's own controls (branch protection, rulesets,
 * CODEOWNERS, secret scanning, CI) own everything past the credential boundary.
 */

const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TOKEN_SECRET = "secret/github";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** A `gh` family plus how to find the repo an invocation touches. */
export interface GhCommandFamily extends CommandFamily {
  /** The repo this argv addresses; null when it cannot be determined (denied). */
  repo(argv: string[]): string | null;
  /** Family-specific guard (e.g. `gh api` must stay read-only); error string or null. */
  check?(argv: string[]): string | null;
}

const repoFlag = (argv: string[]): string | null => flagValue(argv, "--repo", "-R");

/** `gh api` repo paths: `repos/<owner>/<repo>/...` (a leading slash is tolerated). */
function apiRepo(argv: string[]): string | null {
  const path = argv[1];
  if (!path || path.startsWith("-")) return null;
  const m = /^\/?repos\/([\w.-]+\/[\w.-]+)(?:\/|$)/.exec(path);
  return m?.[1] ?? null;
}

/** `gh api` must be a plain GET — no mutations through the generic escape hatch. */
function apiReadOnlyCheck(argv: string[]): string | null {
  const method = flagValue(argv, "--method", "-X");
  if (method && method.toUpperCase() !== "GET") {
    return `gh api is brokered read-only (got --method ${method}) — use an allowlisted write family instead`;
  }
  const forbidden = ["-f", "-F", "--field", "--raw-field", "--input"];
  const hit = argv.find((a) => forbidden.includes(a) || forbidden.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
  if (hit) return `gh api is brokered read-only — request bodies (${hit}) are not allowed`;
  return null;
}

/**
 * The Track 6/7 starter set: reads the agent needs for context, plus the PR
 * create/edit writes the agent-driven delivery path uses (Track 7). Merging a
 * PR is deliberately absent — merge is the human's native approval, and a
 * model-initiated merge is a Proposed Effect (Track 9, §7.9).
 */
export const DEFAULT_GH_FAMILIES: GhCommandFamily[] = [
  { prefix: ["pr", "view"], kind: "read", repo: repoFlag },
  { prefix: ["pr", "diff"], kind: "read", repo: repoFlag },
  { prefix: ["issue", "view"], kind: "read", repo: repoFlag },
  { prefix: ["repo", "view"], kind: "read", repo: (argv) => (argv[2] && !argv[2].startsWith("-") ? argv[2] : null) },
  { prefix: ["api"], kind: "read", repo: apiRepo, check: apiReadOnlyCheck },
  { prefix: ["pr", "create"], kind: "write", repo: repoFlag },
  { prefix: ["pr", "edit"], kind: "write", repo: repoFlag },
];

/**
 * Resolve YAML-granted family names (Track 14, e.g. `["pr view", "api"]`)
 * against the known `gh` families. Unknown names throw at wiring time — a
 * typo in an agent config should fail the boot, not silently widen or narrow
 * the allowlist at call time.
 */
export function ghFamiliesForNames(
  names: string[],
  known: GhCommandFamily[] = DEFAULT_GH_FAMILIES,
): GhCommandFamily[] {
  return names.map((name) => {
    const family = known.find((f) => f.prefix.join(" ") === name.trim());
    if (!family) {
      const knownNames = known.map((f) => f.prefix.join(" ")).join(", ");
      throw new Error(`unknown gh command family "${name}" (known: ${knownNames})`);
    }
    return family;
  });
}

export interface GithubExecOptions {
  /** Repos the broker may address (the task's configured repo(s)). */
  allowedRepos: string[];
  runner?: CommandRunner;
  families?: GhCommandFamily[];
  ghPath?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Secret-store key for the GitHub token (default `secret/github`). */
  tokenSecret?: string;
}

/** argv from the tool input, tolerating a leading "gh". */
function ghArgv(input: ToolInput): string[] {
  const raw = Array.isArray(input.argv) ? input.argv : [];
  const argv = raw.filter((a): a is string => typeof a === "string");
  return argv[0] === "gh" ? argv.slice(1) : argv;
}

/**
 * `github.exec`: run an allowlisted `gh` command with the tenant credential
 * injected host-side. The interface *is* `gh` — structured argv, no shell.
 *
 *   github.exec({ argv: ["pr", "view", "123", "--repo", "owner/repo", "--json", "title,body,files"] })
 */
export function makeGithubExecTool(opts: GithubExecOptions): Tool {
  const families = opts.families ?? DEFAULT_GH_FAMILIES;
  const runner = opts.runner ?? new ExecFileCommandRunner();
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  /** Family + repo for a validated argv; null before validate() has passed. */
  const resolve = (input: ToolInput): { family: GhCommandFamily; repo: string } | null => {
    const argv = ghArgv(input);
    const family = matchCommandFamily(argv, families);
    if (!family) return null;
    const repo = family.repo(argv);
    return repo ? { family, repo } : null;
  };

  return {
    name: "github.exec",
    description:
      "Run an allowlisted `gh` command with Marathon's GitHub credential injected host-side. " +
      "Pass structured arguments (no shell): { argv: [\"pr\", \"view\", \"123\", \"--repo\", \"owner/repo\"] }. " +
      `Allowed families: ${describeFamilies(families)}. Name the repo explicitly (--repo, or the gh api path).`,
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    sources(input): SourceRead[] {
      const r = resolve(input);
      return r && r.family.kind === "read" ? [{ source: `github:${r.repo}`, sensitivity: "company_viewable" }] : [];
    },
    egress(input): EgressTarget | null {
      const r = resolve(input);
      return r && r.family.kind === "write"
        ? { destination: `github:${r.repo}`, audience: "tenant", external: false }
        : null;
    },
    validate(input) {
      if (!Array.isArray(input.argv) || input.argv.length === 0) return "argv (string[]) is required";
      if (!input.argv.every((a) => typeof a === "string")) return "argv must contain only strings";
      const argv = ghArgv(input);
      const family = matchCommandFamily(argv, families);
      if (!family) {
        return `command not in an allowlisted gh family: "${argv.slice(0, 3).join(" ")}" — allowed: ${describeFamilies(families)}`;
      }
      const familyError = family.check?.(argv);
      if (familyError) return familyError;
      const repo = family.repo(argv);
      if (!repo) return `name the repo explicitly (e.g. --repo owner/repo) for gh ${family.prefix.join(" ")}`;
      if (!REPO_RE.test(repo)) return `invalid repo: ${repo}`;
      if (!opts.allowedRepos.includes(repo)) {
        return `repo not allowed: ${repo} — this agent's configured repo is ${opts.allowedRepos.join(", ")}`;
      }
      return null;
    },
    async execute(input, ctx) {
      const argv = ghArgv(input);
      const token = await ctx.secrets.get(opts.tokenSecret ?? DEFAULT_TOKEN_SECRET);
      if (!token) throw new Error(`no github token configured (${opts.tokenSecret ?? DEFAULT_TOKEN_SECRET})`);
      // The credential exists only in the brokered child's env — never in argv,
      // never in the result, never in the sandbox.
      const res = await runner.run(opts.ghPath ?? "gh", argv, {
        env: {
          GH_TOKEN: token,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PAGER: "cat",
          NO_COLOR: "1",
        },
        timeoutMs: opts.timeoutMs,
      });
      const ok = res.exitCode === 0;
      const body = ok ? res.stdout : `gh exited ${res.exitCode}\n${res.stderr || res.stdout}`;
      return {
        content: capOutput(body.trim(), maxChars),
        details: { command: "gh", argv, exit_code: res.exitCode, ok },
      };
    },
  };
}

export interface GitExecOptions {
  /** Repos the broker may push to / fetch from. */
  allowedRepos: string[];
  /**
   * The task's host-side workspace directory (the git checkout the refspec
   * resolves in) — wire to `CodeTaskRegistry`: the broker only operates on a
   * task in its BUILD stage.
   */
  resolveWorkspaceDir(taskId: string): string | null | undefined | Promise<string | null | undefined>;
  runner?: CommandRunner;
  gitPath?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  tokenSecret?: string;
  /** Remote URL for a repo (default `https://github.com/<repo>.git`); demos use local paths. */
  remoteUrl?(repo: string): string;
}

/**
 * `git.exec`: brokered *network* git — `push`/`fetch` against the configured
 * repo, run host-side in the task's workspace with the credential injected via
 * an in-process credential helper (env-fed; never in argv or on disk). Local
 * git (`status`/`diff`/`add`/`commit`/branching) belongs in the sandbox, not
 * here.
 *
 * Destructive pushes are unrepresentable (Tracks 6/9): flags are refused
 * wholesale (no `--force`/`--delete`), a `+`-prefixed refspec (the refspec
 * form of force) is rejected, and an empty-source refspec (`:refs/heads/x`,
 * the refspec form of remote deletion) is rejected. Deleting a branch is a
 * Proposed Effect, not a push.
 *
 *   git.exec({ argv: ["push", "owner/repo", "HEAD:refs/heads/marathon/my-branch"] })
 */
export function makeGitExecTool(opts: GitExecOptions): Tool {
  const runner = opts.runner ?? new ExecFileCommandRunner();
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const remoteUrl = opts.remoteUrl ?? ((repo: string) => `https://github.com/${repo}.git`);

  const parse = (input: ToolInput): { op: "push" | "fetch"; repo: string; refspecs: string[] } | null => {
    const raw = Array.isArray(input.argv) ? input.argv : [];
    const argv = raw.filter((a): a is string => typeof a === "string");
    const [op, repo, ...refspecs] = argv[0] === "git" ? argv.slice(1) : argv;
    if (op !== "push" && op !== "fetch") return null;
    if (!repo || !REPO_RE.test(repo)) return null;
    return { op, repo, refspecs };
  };

  return {
    name: "git.exec",
    description:
      "Run a credentialed network git operation (push or fetch) against the configured repo, host-side. " +
      'Pass the repo where a remote would go: { argv: ["push", "owner/repo", "HEAD:refs/heads/my-branch"] }. ' +
      "Local git (status/diff/add/commit) runs in your sandbox workspace, not through this tool. " +
      "Flags are not allowed (no --force).",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    sources(input): SourceRead[] {
      const p = parse(input);
      return p?.op === "fetch" ? [{ source: `github:${p.repo}`, sensitivity: "company_viewable" }] : [];
    },
    egress(input): EgressTarget | null {
      const p = parse(input);
      return p?.op === "push" ? { destination: `github:${p.repo}`, audience: "tenant", external: false } : null;
    },
    validate(input) {
      if (!Array.isArray(input.argv) || input.argv.length === 0) return "argv (string[]) is required";
      if (!input.argv.every((a) => typeof a === "string")) return "argv must contain only strings";
      const p = parse(input);
      if (!p) return 'argv must be ["push"|"fetch", "owner/repo", ...refspecs]';
      if (!opts.allowedRepos.includes(p.repo)) {
        return `repo not allowed: ${p.repo} — this agent's configured repo is ${opts.allowedRepos.join(", ")}`;
      }
      if (p.refspecs.length === 0) return `at least one refspec is required for git ${p.op}`;
      const flag = p.refspecs.find((r) => r.startsWith("-"));
      if (flag) return `flags are not allowed through the broker: ${flag}`;
      if (p.op === "push") {
        const forced = p.refspecs.find((r) => r.startsWith("+"));
        if (forced) return `force push is not allowed through the broker: ${forced}`;
        const deletion = p.refspecs.find((r) => r.startsWith(":"));
        if (deletion)
          return `deleting a remote ref is not allowed through the broker (${deletion}) — propose it as a destructive effect instead (§7.9)`;
        const malformed = p.refspecs.find((r) => !r.includes(":") || r.endsWith(":"));
        if (malformed) return `push refspecs must be explicit <src>:<dst>: ${malformed}`;
      }
      return null;
    },
    async execute(input, ctx) {
      const p = parse(input);
      if (!p) throw new Error("git.exec: invalid argv"); // unreachable after validate()
      const dir = await opts.resolveWorkspaceDir(ctx.taskId);
      if (!dir) {
        throw new CodeHandoffError(
          "NO_WORKSPACE",
          `no code workspace is bound to task ${ctx.taskId} — git.exec is only available during a BUILD stage`,
        );
      }
      const token = await ctx.secrets.get(opts.tokenSecret ?? DEFAULT_TOKEN_SECRET);
      if (!token) throw new Error(`no github token configured (${opts.tokenSecret ?? DEFAULT_TOKEN_SECRET})`);
      // The helper reads the token from the child env — the token is never an
      // argument, so it cannot appear in a process list, trace, or error text.
      const helper = 'credential.helper=!f() { echo "username=x-access-token"; echo "password=${MARATHON_GIT_TOKEN}"; }; f';
      const argv = ["-C", dir, "-c", "credential.helper=", "-c", helper, p.op, remoteUrl(p.repo), ...p.refspecs];
      const res = await runner.run(opts.gitPath ?? "git", argv, {
        env: { MARATHON_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: opts.timeoutMs,
      });
      const ok = res.exitCode === 0;
      // git push/fetch report progress on stderr even on success.
      const body = ok
        ? `${p.op} ok\n${(res.stderr || res.stdout).trim()}`
        : `git ${p.op} exited ${res.exitCode}\n${(res.stderr || res.stdout).trim()}`;
      return {
        content: capOutput(body.trim(), maxChars),
        details: { command: "git", argv: [p.op, p.repo, ...p.refspecs], exit_code: res.exitCode, ok },
      };
    },
  };
}
