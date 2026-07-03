import { execFile } from "node:child_process";

/**
 * Host-side command brokering (code-migration.md Track 6). The agent works with
 * normal CLI workflows (`gh`, `git`) instead of custom semantic tools; Marathon's
 * job is to keep write credentials out of the model and the sandbox. A brokered
 * tool validates the argv against an allowlist of explicit *command families*,
 * injects the credential into the child process env only, and records the
 * command, exit code, and output summary — the credential is never part of the
 * argv, the recorded trace, or the model-visible result.
 */
export interface BrokeredCommandResult {
  /** The child's exit code. Non-zero is data for the agent, not an error. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  /**
   * Extra env for the child ONLY (the credential injection point). The child
   * does NOT inherit the broker host's env — only {@link BASE_ENV_KEYS} plus
   * these entries — so unrelated host secrets (Slack tokens, DB URLs, cloud
   * creds) never reach a brokered command.
   */
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * The only host env vars a brokered child inherits: what `gh`/`git` need to
 * find binaries, config, and locale — never secrets. Everything else must be
 * injected explicitly via {@link CommandRunOptions.env}.
 */
export const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

function baseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Executes one brokered command. Swappable so tests/demos never need real binaries. */
export interface CommandRunner {
  run(bin: string, argv: string[], opts?: CommandRunOptions): Promise<BrokeredCommandResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The real runner: `execFile` (argv array, no shell — no quoting/injection
 * surface). The child env is minimal by construction ({@link BASE_ENV_KEYS} +
 * the injected entries), so host secrets never leak into brokered commands.
 * A non-zero exit resolves with the code; only spawn failures and timeouts
 * reject.
 */
export class ExecFileCommandRunner implements CommandRunner {
  run(bin: string, argv: string[], opts: CommandRunOptions = {}): Promise<BrokeredCommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        argv,
        {
          env: { ...baseEnv(process.env), ...opts.env },
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        },
        (err, stdout, stderr) => {
          if (err) {
            // Killed by the timeout (or a signal): there is no meaningful exit code.
            if (err.killed || typeof err.code !== "number") {
              return reject(
                err.killed ? new Error(`${bin} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`) : err,
              );
            }
            return resolve({ exitCode: err.code, stdout: String(stdout), stderr: String(stderr) });
          }
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }
}

/** Deterministic runner for tests/demos: records calls, replays scripted results. */
export class FakeCommandRunner implements CommandRunner {
  public readonly calls: Array<{ bin: string; argv: string[]; opts: CommandRunOptions }> = [];
  constructor(
    private readonly respond: (
      bin: string,
      argv: string[],
      opts: CommandRunOptions,
    ) => BrokeredCommandResult | Promise<BrokeredCommandResult> = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ) {}

  async run(bin: string, argv: string[], opts: CommandRunOptions = {}): Promise<BrokeredCommandResult> {
    this.calls.push({ bin, argv, opts });
    return this.respond(bin, argv, opts);
  }
}

/**
 * One allowlisted subcommand family, e.g. `gh pr view` = `{ prefix: ["pr","view"] }`.
 * Explicit families are the policy — prefer adding a family over growing a
 * policy language (Track 6).
 */
export interface CommandFamily {
  prefix: string[];
  /** `read` enters the source ledger; `write` is egress-routed (§7.8). */
  kind: "read" | "write";
}

/** Longest-prefix match of an argv against the allowlisted families. */
export function matchCommandFamily<F extends CommandFamily>(argv: string[], families: F[]): F | null {
  let best: F | null = null;
  for (const f of families) {
    const matches = f.prefix.length <= argv.length && f.prefix.every((p, i) => argv[i] === p);
    if (matches && (!best || f.prefix.length > best.prefix.length)) best = f;
  }
  return best;
}

/**
 * The value of a flag in an argv, supporting `--flag value`, `--flag=value`,
 * and short aliases (`-R value`). Null when absent.
 */
export function flagValue(argv: string[], ...flags: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (flags.includes(a)) return argv[i + 1] ?? null;
    for (const f of flags) {
      if (f.startsWith("--") && a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return null;
}

/** Human-readable family list for error messages ("pr view, pr diff, …"). */
export function describeFamilies(families: CommandFamily[]): string {
  return families.map((f) => f.prefix.join(" ")).join(", ");
}

/** Cap a command's output for the model-visible result; the tail is dropped. */
export function capOutput(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n… (output truncated)` : s;
}
