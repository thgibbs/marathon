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
  // document writes (branch + file + PR)
  getRef(repo: string, ref: string): Promise<{ sha: string }>;
  createBranch(repo: string, branch: string, fromSha: string): Promise<void>;
  putFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
    sha?: string,
  ): Promise<{ commitSha: string; contentSha: string }>;
  createPullRequest(repo: string, title: string, head: string, base: string, body?: string): Promise<{ number: number; url: string }>;
  closePullRequest(repo: string, prNumber: number): Promise<void>;
  deleteRef(repo: string, branch: string): Promise<void>;
  replyToReviewComment(repo: string, pullNumber: number, commentId: number, body: string): Promise<{ id: number }>;
  // permission / identity (M6 repo-permission checks)
  /** Repo metadata if the *agent's* token can see it; null if not accessible (404). */
  getRepo(repo: string): Promise<{ private: boolean } | null>;
  /** A user's permission on the repo: admin|write|read|none. */
  getUserRepoPermission(repo: string, username: string): Promise<RepoPermission>;
}

export type RepoPermission = "admin" | "write" | "read" | "none";

export interface RepoAccess {
  agentOk: boolean;
  userOk: boolean;
  userPermission: RepoPermission;
}

/**
 * Verify both the agent (its token) and the invoking user may access the repo
 * before any document read/write (design §7.17). `userOk` requires at least read.
 */
export async function getRepoAccess(client: GithubClient, repo: string, username: string): Promise<RepoAccess> {
  const repoInfo = await client.getRepo(repo);
  const agentOk = repoInfo !== null;
  const userPermission = agentOk ? await client.getUserRepoPermission(repo, username) : "none";
  return { agentOk, userOk: userPermission !== "none", userPermission };
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

  async getRef(repo: string, ref: string): Promise<{ sha: string }> {
    const j = await this.api(`/repos/${repo}/git/ref/${ref}`);
    return { sha: j.object.sha };
  }

  async createBranch(repo: string, branch: string, fromSha: string): Promise<void> {
    await this.api(`/repos/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: fromSha },
    });
  }

  async putFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
    sha?: string,
  ): Promise<{ commitSha: string; contentSha: string }> {
    const j = await this.api(`/repos/${repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      body: { message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha },
    });
    return { commitSha: j.commit?.sha, contentSha: j.content?.sha };
  }

  async createPullRequest(repo: string, title: string, head: string, base: string, body?: string): Promise<{ number: number; url: string }> {
    const j = await this.api(`/repos/${repo}/pulls`, { method: "POST", body: { title, head, base, body } });
    return { number: j.number, url: j.html_url };
  }

  async closePullRequest(repo: string, prNumber: number): Promise<void> {
    await this.api(`/repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: { state: "closed" } });
  }

  async deleteRef(repo: string, branch: string): Promise<void> {
    await this.api(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
  }

  async replyToReviewComment(repo: string, pullNumber: number, commentId: number, body: string): Promise<{ id: number }> {
    const j = await this.api(`/repos/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`, { method: "POST", body: { body } });
    return { id: j.id };
  }

  async getRepo(repo: string): Promise<{ private: boolean } | null> {
    try {
      const j = await this.api(`/repos/${repo}`);
      return { private: Boolean(j.private) };
    } catch (e) {
      // GitHub returns 404 (not 403) for repos a token cannot see.
      if (/github 404/.test(String(e))) return null;
      throw e;
    }
  }

  async getUserRepoPermission(repo: string, username: string): Promise<RepoPermission> {
    try {
      const j = await this.api(`/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`);
      const p = j.permission;
      return p === "admin" || p === "write" || p === "read" ? p : "none";
    } catch (e) {
      if (/github 404/.test(String(e))) return "none";
      throw e;
    }
  }
}

/** Deterministic client for tests/CI. */
export class FixturesGithubClient implements GithubClient {
  constructor(
    private readonly fixtures: {
      files?: Record<string, GithubFile>;
      contents?: Record<string, GithubEntry[]>;
      /** repo -> access; default: agent can access. Set botAccess:false to deny the agent. */
      repos?: Record<string, { private?: boolean; botAccess?: boolean }>;
      /** "repo:username" -> permission; default: "write". */
      userPermissions?: Record<string, RepoPermission>;
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

  private readonly fileShas = new Map<string, string>();
  private prSeq = 1;
  public refSha = "base-sha-0000";

  async getRef(_repo: string, _ref: string): Promise<{ sha: string }> {
    return { sha: this.refSha };
  }

  async createBranch(repo: string, branch: string, fromSha: string): Promise<void> {
    this.writes.push({ op: "createBranch", args: { repo, branch, fromSha } });
  }

  async putFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    _message: string,
    sha?: string,
  ): Promise<{ commitSha: string; contentSha: string }> {
    const key = `${repo}:${path}`;
    const current = this.fileShas.get(key);
    // stale-SHA rejection: updating with a sha that no longer matches.
    if (sha !== undefined && current !== undefined && sha !== current) {
      throw new Error(`github 409: file ${path} changed (stale sha)`);
    }
    const contentSha = `sha-${this.issueSeq++}`;
    this.fileShas.set(key, contentSha);
    this.writes.push({ op: "putFile", args: { repo, path, branch, sha, content } });
    return { commitSha: `commit-${this.issueSeq}`, contentSha };
  }

  async createPullRequest(repo: string, title: string, head: string, base: string): Promise<{ number: number; url: string }> {
    const number = this.prSeq++;
    this.writes.push({ op: "createPullRequest", args: { repo, title, head, base } });
    return { number, url: `https://example.test/${repo}/pull/${number}` };
  }

  async closePullRequest(repo: string, prNumber: number): Promise<void> {
    this.writes.push({ op: "closePullRequest", args: { repo, prNumber } });
  }

  async deleteRef(repo: string, branch: string): Promise<void> {
    this.writes.push({ op: "deleteRef", args: { repo, branch } });
  }

  async replyToReviewComment(repo: string, pullNumber: number, commentId: number, body: string): Promise<{ id: number }> {
    this.writes.push({ op: "replyToReviewComment", args: { repo, pullNumber, commentId, body } });
    return { id: this.issueSeq++ };
  }

  async getRepo(repo: string): Promise<{ private: boolean } | null> {
    const r = this.fixtures.repos?.[repo];
    if (r?.botAccess === false) return null;
    return { private: r?.private ?? false };
  }

  async getUserRepoPermission(repo: string, username: string): Promise<RepoPermission> {
    return this.fixtures.userPermissions?.[`${repo}:${username}`] ?? "write";
  }
}
