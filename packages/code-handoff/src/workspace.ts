import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The sandbox user's HOME inside the mounted workspace (Track 11): package
 * caches need task-sized disk, not the container's small tmpfs. Excluded from
 * the workspace's git view (below), so caches never enter diffs, tree hashes,
 * or commits.
 */
export const SANDBOX_HOME_DIRNAME = ".marathon-home";

export interface MaterializeOptions {
  /** Clone source: a local repo path or a (possibly credentialed) URL. Host-side only. */
  source: string;
  /** The pinned commit the work builds on (design §29.1). */
  baseSha: string;
  prefix?: string;
}

/**
 * The code-task workspace (design §29.2): a host-side clone of the repo at
 * `base_sha` (detached), with remotes and credential helpers stripped before it
 * is mounted into the sandbox at /workspace. The workspace *is* the artifact —
 * the handoff reads `git diff base_sha..worktree` from here, never from model
 * output. Teardown always destroys it; the only durable outputs are the pushed
 * branch, the PR, and the task records.
 */
export class CodeWorkspace {
  private constructor(
    readonly dir: string,
    readonly baseSha: string,
  ) {}

  static async materialize(opts: MaterializeOptions): Promise<CodeWorkspace> {
    const dir = await mkdtemp(join(tmpdir(), opts.prefix ?? "marathon-code-"));
    try {
      await execFileAsync("git", ["clone", "--quiet", opts.source, dir], { maxBuffer: 16 * 1024 * 1024 });
      const ws = new CodeWorkspace(dir, opts.baseSha);
      await ws.git(["checkout", "--quiet", "--detach", opts.baseSha]);
      await ws.stripAndSeal();
      return ws;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * A **read-only** chat-grounding workspace (chat-repo.md §3.3): a shallow
   * clone of the repo at `ref` (the default branch when omitted), remotes +
   * credential helpers stripped, mounted read-only. Unlike {@link materialize}
   * it carries no diff/commit machinery and is not pinned to a plan — its whole
   * job is to give a chat agent local files to read. Returns the exact resolved
   * commit `sha` so the caller can pin the task to it and record it as a source
   * (§7.8). The clone stays shallow (`--depth 1`): history is never needed.
   */
  static async materializeReadonly(opts: {
    source: string;
    /**
     * What to check out: an exact commit sha (pinned mode — a full clone, then
     * `checkout --detach <sha>`, since a shallow clone can't name an arbitrary
     * commit), a branch/tag name, or — when omitted — the remote's default
     * branch at HEAD (shallow, the common single-turn case).
     */
    ref?: string;
    prefix?: string;
  }): Promise<{ workspace: CodeWorkspace; sha: string }> {
    const dir = await mkdtemp(join(tmpdir(), opts.prefix ?? "marathon-chat-"));
    try {
      const pinnedSha = opts.ref && /^[0-9a-f]{7,40}$/i.test(opts.ref) ? opts.ref : undefined;
      if (pinnedSha) {
        await execFileAsync("git", ["clone", "--quiet", opts.source, dir], { maxBuffer: 16 * 1024 * 1024 });
        await execFileAsync("git", ["-C", dir, "checkout", "--quiet", "--detach", pinnedSha]);
      } else {
        const cloneArgs = ["clone", "--quiet", "--depth", "1"];
        if (opts.ref) cloneArgs.push("--branch", opts.ref);
        cloneArgs.push(opts.source, dir);
        await execFileAsync("git", cloneArgs, { maxBuffer: 16 * 1024 * 1024 });
      }
      // The resolved commit — what the agent actually read (pin + source ledger).
      const sha = (await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
      const ws = new CodeWorkspace(dir, sha);
      await ws.stripAndSeal();
      return { workspace: ws, sha };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Strip remotes + credential helpers (§29.2 — the sandbox never fetches, and a
   * credentialed clone URL must not persist in `.git/config`), set a local
   * identity for advisory scratch commits, and keep the sandbox HOME out of the
   * workspace's git view. Shared by both materialization paths.
   */
  private async stripAndSeal(): Promise<void> {
    for (const remote of await this.remotes()) await this.git(["remote", "remove", remote]);
    await this.git(["config", "--local", "--unset-all", "credential.helper"]).catch(() => {});
    // Shadow any global/system helper for host-side git ops in this workspace.
    await this.git(["config", "--local", "credential.helper", ""]);
    // Local scratch commits (advisory, §29.2) need an identity inside the sandbox.
    await this.git(["config", "--local", "user.name", "Marathon"]);
    await this.git(["config", "--local", "user.email", "marathon@localhost"]);
    // The sandbox HOME lives inside the mount (Track 11) — keep its caches out
    // of the workspace's git view (diffs, tree hash, commits) without touching
    // the repo's own .gitignore.
    await mkdir(join(this.dir, ".git", "info"), { recursive: true });
    await appendFile(join(this.dir, ".git", "info", "exclude"), `\n${SANDBOX_HOME_DIRNAME}/\n`);
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.dir, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  /** Run git with data piped to stdin (used by diff replay). */
  private gitWithInput(args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", this.dir, ...args], { stdio: ["pipe", "ignore", "pipe"] });
      const err: Buffer[] = [];
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${args[0]} failed (exit ${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  async remotes(): Promise<string[]> {
    const out = await this.git(["remote"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** All local credential.helper values (for asserting the strip in tests). */
  async credentialHelpers(): Promise<string[]> {
    const out = await this.git(["config", "--local", "--get-all", "credential.helper"]).catch(() => "");
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Stage everything so untracked files count as part of the working tree. */
  private async stageAll(): Promise<void> {
    await this.git(["add", "-A"]);
  }

  /**
   * The authoritative artifact (§29): `git diff base_sha..worktree`, including
   * untracked files, as a binary-safe patch usable for snapshot/replay (K4).
   */
  async captureDiff(): Promise<string> {
    await this.stageAll();
    return this.git(["diff", "--binary", "--no-renames", "--cached", this.baseSha]);
  }

  /**
   * Paths changed relative to base_sha (protected-path checks + the host-side
   * commit). Rename detection is disabled so a rename lists BOTH paths — the
   * commit builder must delete the old path, not just add the new one.
   */
  async changedFiles(): Promise<string[]> {
    await this.stageAll();
    const out = await this.git(["diff", "--cached", "--name-only", "--no-renames", this.baseSha]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Git tree hash of the current working tree — the submit idempotency anchor (§29.4). */
  async treeHash(): Promise<string> {
    await this.stageAll();
    return (await this.git(["write-tree"])).trim();
  }

  /** Replay a captured diff onto a fresh clone at base_sha (K4 resume). */
  async applyDiff(diff: string): Promise<void> {
    if (!diff.trim()) return;
    await this.gitWithInput(["apply", "--binary", "--index", "-"], diff);
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  async readFile(rel: string): Promise<string> {
    return readFile(this.path(rel), "utf8");
  }

  /** Read a changed file for the host-side commit; null if it was deleted. */
  async readFileBase64(rel: string): Promise<string | null> {
    try {
      return (await readFile(this.path(rel))).toString("base64");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Git file mode for the commit tree (executable bit honored). */
  async fileMode(rel: string): Promise<"100644" | "100755"> {
    const s = await stat(this.path(rel));
    return (s.mode & 0o111) !== 0 ? "100755" : "100644";
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }

  async deleteFile(rel: string): Promise<void> {
    await rm(this.path(rel), { force: true });
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
