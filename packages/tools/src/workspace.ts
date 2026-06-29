import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * An ephemeral working directory for a sandboxed task (design §12.6). Materialize
 * the task's files into it, mount it into a {@link DockerSandbox} (`workspaceDir`),
 * then dispose — nothing persists across tasks. The host populates it (e.g. a repo
 * checkout); the sandbox sees only this directory.
 */
export class Workspace {
  private constructor(readonly dir: string) {}

  static async create(prefix = "marathon-ws-"): Promise<Workspace> {
    return new Workspace(await mkdtemp(join(tmpdir(), prefix)));
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }

  async readFile(rel: string): Promise<string> {
    return readFile(this.path(rel), "utf8");
  }

  async list(): Promise<string[]> {
    return readdir(this.dir);
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
