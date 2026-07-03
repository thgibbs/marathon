import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      // Strip remotes + credential helpers (§29.2): the sandbox never fetches, and a
      // credentialed clone URL must not persist in .git/config.
      for (const remote of await ws.remotes()) await ws.git(["remote", "remove", remote]);
      await ws.git(["config", "--local", "--unset-all", "credential.helper"]).catch(() => {});
      // Shadow any global/system helper for host-side git ops in this workspace.
      await ws.git(["config", "--local", "credential.helper", ""]);
      // Local scratch commits (advisory, §29.2) need an identity inside the sandbox.
      await ws.git(["config", "--local", "user.name", "Marathon"]);
      await ws.git(["config", "--local", "user.email", "marathon@localhost"]);
      return ws;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
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
