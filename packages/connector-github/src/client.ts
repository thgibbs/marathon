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
  // writes
  createIssue(repo: string, title: string, body?: string): Promise<{ number: number; url: string }>;
  commentIssue(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  mergePullRequest(repo: string, prNumber: number): Promise<{ merged: boolean; sha?: string }>;
}

/** Real read-only GitHub client (Contents API). */
export class HttpGithubClient implements GithubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "marathon",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    if (res.status === 204) return null;
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

  async createIssue(repo: string, title: string, body?: string): Promise<{ number: number; url: string }> {
    const j = await this.api(`/repos/${repo}/issues`, { method: "POST", body: { title, body } });
    return { number: j.number, url: j.html_url };
  }

  async commentIssue(repo: string, issueNumber: number, body: string): Promise<{ id: number }> {
    const j = await this.api(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: { body },
    });
    return { id: j.id };
  }

  async closeIssue(repo: string, issueNumber: number): Promise<void> {
    await this.api(`/repos/${repo}/issues/${issueNumber}`, { method: "PATCH", body: { state: "closed" } });
  }

  async mergePullRequest(repo: string, prNumber: number): Promise<{ merged: boolean; sha?: string }> {
    const j = await this.api(`/repos/${repo}/pulls/${prNumber}/merge`, { method: "PUT" });
    return { merged: Boolean(j.merged), sha: j.sha };
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

  /** Recorded write operations (for assertions in tests/demos). */
  public readonly writes: Array<{ op: string; args: unknown }> = [];
  private issueSeq = 1000;

  async createIssue(repo: string, title: string, body?: string): Promise<{ number: number; url: string }> {
    const number = this.issueSeq++;
    this.writes.push({ op: "createIssue", args: { repo, title, body } });
    return { number, url: `https://example.test/${repo}/issues/${number}` };
  }

  async commentIssue(repo: string, issueNumber: number, body: string): Promise<{ id: number }> {
    this.writes.push({ op: "commentIssue", args: { repo, issueNumber, body } });
    return { id: this.issueSeq++ };
  }

  async closeIssue(repo: string, issueNumber: number): Promise<void> {
    this.writes.push({ op: "closeIssue", args: { repo, issueNumber } });
  }

  async mergePullRequest(repo: string, prNumber: number): Promise<{ merged: boolean; sha?: string }> {
    this.writes.push({ op: "mergePullRequest", args: { repo, prNumber } });
    return { merged: true, sha: "deadbeef" };
  }
}
