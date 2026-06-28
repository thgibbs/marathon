export interface GithubFile {
  path: string;
  content: string;
}

export interface GithubEntry {
  name: string;
  type: string;
  path: string;
}

export interface GithubClient {
  readFile(repo: string, path: string, ref?: string): Promise<GithubFile>;
  listContents(repo: string, path?: string, ref?: string): Promise<GithubEntry[]>;
}

/** Real read-only GitHub client (Contents API). */
export class HttpGithubClient implements GithubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async api(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "marathon",
      },
    });
    if (!res.ok) {
      throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  async readFile(repo: string, path: string, ref?: string): Promise<GithubFile> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const j = await this.api(`/repos/${repo}/contents/${encodeURI(path)}${q}`);
    if (Array.isArray(j)) throw new Error(`${path} is a directory, not a file`);
    const content = Buffer.from(String(j.content ?? ""), j.encoding ?? "base64").toString("utf8");
    return { path: j.path, content };
  }

  async listContents(repo: string, path = "", ref?: string): Promise<GithubEntry[]> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const j = await this.api(`/repos/${repo}/contents/${encodeURI(path)}${q}`);
    const arr = Array.isArray(j) ? j : [j];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return arr.map((e: any) => ({ name: e.name, type: e.type, path: e.path }));
  }
}

/** Deterministic client for tests/CI. */
export class FixturesGithubClient implements GithubClient {
  constructor(
    private readonly fixtures: {
      files?: Record<string, GithubFile>;
      contents?: Record<string, GithubEntry[]>;
    },
  ) {}

  async readFile(repo: string, path: string): Promise<GithubFile> {
    const f = this.fixtures.files?.[`${repo}:${path}`];
    if (!f) throw new Error(`fixture missing: readFile ${repo}:${path}`);
    return f;
  }

  async listContents(repo: string, path = ""): Promise<GithubEntry[]> {
    const c = this.fixtures.contents?.[`${repo}:${path}`];
    if (!c) throw new Error(`fixture missing: listContents ${repo}:${path}`);
    return c;
  }
}
