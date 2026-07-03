export interface GithubFile {
  path: string;
  content: string;
}

export interface GithubEntry {
  name: string;
  type: string;
  path: string;
}

/** One entry of a commit tree built from a captured workspace diff (§29.4 step 4). */
export interface GitTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  /** Blob sha for adds/modifies; null deletes the path (relative to the base tree). */
  sha: string | null;
}

export interface GithubClient {
  readFile(repo: string, path: string, ref?: string): Promise<GithubFile>;
  readFileWithSha(repo: string, path: string, ref?: string): Promise<GithubFile & { sha: string }>;
  listContents(repo: string, path?: string, ref?: string): Promise<GithubEntry[]>;
  // writes
  createIssue(repo: string, title: string, body?: string): Promise<{ number: number; url: string }>;
  commentIssue(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  mergePullRequest(
    repo: string,
    prNumber: number,
    opts?: { method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string }>;
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
  createPullRequest(
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
    opts?: { draft?: boolean },
  ): Promise<{ number: number; url: string }>;
  closePullRequest(repo: string, prNumber: number): Promise<void>;
  deleteRef(repo: string, branch: string): Promise<void>;
  replyToReviewComment(repo: string, pullNumber: number, commentId: number, body: string): Promise<{ id: number }>;
  // code handoff (K1, design §29.4-§29.5): commit a captured diff host-side via the
  // Git Data API, push the task branch, and create-or-update the code PR.
  getCommit(repo: string, sha: string): Promise<{ sha: string; treeSha: string }>;
  createBlob(repo: string, contentBase64: string): Promise<{ sha: string }>;
  createTree(repo: string, baseTreeSha: string, entries: GitTreeEntry[]): Promise<{ sha: string }>;
  createCommit(repo: string, message: string, treeSha: string, parentShas: string[]): Promise<{ sha: string }>;
  /** Move a branch ref; force approximates `--force-with-lease` (a task owns its own branch). */
  updateRef(repo: string, branch: string, sha: string, force: boolean): Promise<void>;
  findPullRequestByHead(repo: string, head: string): Promise<{ number: number; url: string; draft: boolean } | null>;
  /** PR by number, or null if the repo has no such PR (delivery.report_pr validation). */
  getPullRequest(
    repo: string,
    prNumber: number,
  ): Promise<{ number: number; url: string; headRef: string; draft: boolean; state: string } | null>;
  updatePullRequest(repo: string, prNumber: number, patch: { title?: string; body?: string }): Promise<void>;
  /** Toggle a PR's draft state (§29.3: draft must track verification). */
  setPullRequestDraft(repo: string, prNumber: number, draft: boolean): Promise<void>;
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
  /** Remove a label; removing an absent label is a no-op. */
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
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
    const { path: p, content } = await this.readFileWithSha(repo, path, ref);
    return { path: p, content };
  }

  async readFileWithSha(repo: string, path: string, ref?: string): Promise<GithubFile & { sha: string }> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const j = await this.api(`/repos/${repo}/contents/${encodeURI(path)}${q}`);
    if (Array.isArray(j)) throw new Error(`${path} is a directory, not a file`);
    const content = Buffer.from(String(j.content ?? ""), j.encoding ?? "base64").toString("utf8");
    return { path: j.path, content, sha: j.sha };
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

  async mergePullRequest(
    repo: string,
    prNumber: number,
    opts?: { method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string }> {
    const j = await this.api(`/repos/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: opts?.method ? { merge_method: opts.method } : undefined,
    });
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

  async createPullRequest(
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
    opts?: { draft?: boolean },
  ): Promise<{ number: number; url: string }> {
    const j = await this.api(`/repos/${repo}/pulls`, {
      method: "POST",
      body: { title, head, base, body, draft: opts?.draft ?? false },
    });
    return { number: j.number, url: j.html_url };
  }

  async closePullRequest(repo: string, prNumber: number): Promise<void> {
    await this.api(`/repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: { state: "closed" } });
  }

  async getCommit(repo: string, sha: string): Promise<{ sha: string; treeSha: string }> {
    const j = await this.api(`/repos/${repo}/git/commits/${sha}`);
    return { sha: j.sha, treeSha: j.tree.sha };
  }

  async createBlob(repo: string, contentBase64: string): Promise<{ sha: string }> {
    const j = await this.api(`/repos/${repo}/git/blobs`, {
      method: "POST",
      body: { content: contentBase64, encoding: "base64" },
    });
    return { sha: j.sha };
  }

  async createTree(repo: string, baseTreeSha: string, entries: GitTreeEntry[]): Promise<{ sha: string }> {
    const j = await this.api(`/repos/${repo}/git/trees`, {
      method: "POST",
      body: {
        base_tree: baseTreeSha,
        tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
      },
    });
    return { sha: j.sha };
  }

  async createCommit(repo: string, message: string, treeSha: string, parentShas: string[]): Promise<{ sha: string }> {
    const j = await this.api(`/repos/${repo}/git/commits`, {
      method: "POST",
      body: { message, tree: treeSha, parents: parentShas },
    });
    return { sha: j.sha };
  }

  async updateRef(repo: string, branch: string, sha: string, force: boolean): Promise<void> {
    await this.api(`/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha, force } });
  }

  async findPullRequestByHead(repo: string, head: string): Promise<{ number: number; url: string; draft: boolean } | null> {
    const owner = repo.split("/")[0];
    const j = await this.api(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    const pr = Array.isArray(j) ? j[0] : undefined;
    return pr ? { number: pr.number, url: pr.html_url, draft: Boolean(pr.draft) } : null;
  }

  async getPullRequest(
    repo: string,
    prNumber: number,
  ): Promise<{ number: number; url: string; headRef: string; draft: boolean; state: string } | null> {
    try {
      const j = await this.api(`/repos/${repo}/pulls/${prNumber}`);
      return {
        number: j.number,
        url: j.html_url,
        headRef: String(j.head?.ref ?? ""),
        draft: Boolean(j.draft),
        state: String(j.state ?? "open"),
      };
    } catch (e) {
      if (/github 404/.test(String(e))) return null;
      throw e;
    }
  }

  async updatePullRequest(repo: string, prNumber: number, patch: { title?: string; body?: string }): Promise<void> {
    await this.api(`/repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: patch });
  }

  /** Draft state can only be changed via GraphQL — the REST pulls PATCH ignores `draft`. */
  async setPullRequestDraft(repo: string, prNumber: number, draft: boolean): Promise<void> {
    const pr = await this.api(`/repos/${repo}/pulls/${prNumber}`);
    const mutation = draft
      ? `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`
      : `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`;
    await this.graphql(mutation, { id: pr.node_id });
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "marathon",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`github graphql ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { errors?: Array<{ message: string }> };
    if (j.errors?.length) throw new Error(`github graphql: ${j.errors[0]!.message}`);
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.api(`/repos/${repo}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } });
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    try {
      await this.api(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
    } catch (e) {
      if (!/github 404/.test(String(e))) throw e; // absent label -> no-op
    }
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

  async readFileWithSha(repo: string, path: string): Promise<GithubFile & { sha: string }> {
    const key = `${repo}:${path}`;
    const f = this.fixtures.files?.[key];
    // Content written via putFile wins over the static fixture (write-through,
    // so retry-convergence paths can compare against what actually landed).
    return {
      path,
      content: this.fileContents.get(key) ?? f?.content ?? "",
      sha: this.fileShas.get(key) ?? "sha-existing",
    };
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

  async mergePullRequest(
    repo: string,
    prNumber: number,
    opts?: { method?: "merge" | "squash" | "rebase" },
  ): Promise<{ merged: boolean; sha?: string }> {
    this.writes.push({ op: "mergePullRequest", args: { repo, prNumber, ...(opts?.method ? { method: opts.method } : {}) } });
    return { merged: true, sha: "deadbeef" };
  }

  private readonly fileShas = new Map<string, string>();
  private readonly fileContents = new Map<string, string>();
  private prSeq = 1;
  public refSha = "base-sha-0000";

  async getRef(_repo: string, _ref: string): Promise<{ sha: string }> {
    return { sha: this.refSha };
  }

  async createBranch(repo: string, branch: string, fromSha: string): Promise<void> {
    const key = `${repo}:${branch}`;
    const existing = this.branchShas.get(key);
    // Re-creating at the same sha is a no-op; at a different sha GitHub 422s.
    if (existing !== undefined && existing !== fromSha)
      throw new Error(`github 422: reference already exists: ${branch}`);
    this.writes.push({ op: "createBranch", args: { repo, branch, fromSha } });
    this.branchShas.set(key, fromSha);
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
    this.fileContents.set(key, content);
    this.writes.push({ op: "putFile", args: { repo, path, branch, sha, content } });
    return { commitSha: `commit-${this.issueSeq}`, contentSha };
  }

  async createPullRequest(
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
    opts?: { draft?: boolean },
  ): Promise<{ number: number; url: string }> {
    const number = this.prSeq++;
    const url = `https://example.test/${repo}/pull/${number}`;
    this.writes.push({ op: "createPullRequest", args: { repo, title, head, base, body, draft: opts?.draft ?? false } });
    this.openPrs.set(`${repo}:${head}`, { number, url, draft: opts?.draft ?? false, title, body });
    return { number, url };
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

  // --- code handoff (K1) ---

  /** Open PRs by "repo:head" (for create-or-update assertions). */
  public readonly openPrs = new Map<
    string,
    { number: number; url: string; draft: boolean; title?: string; body?: string }
  >();
  /** Branch heads by "repo:branch" (set by createBranch/updateRef). */
  public readonly branchShas = new Map<string, string>();
  /** Labels by "repo:number". */
  public readonly labels = new Map<string, string[]>();
  private gitSeq = 1;

  async getCommit(repo: string, sha: string): Promise<{ sha: string; treeSha: string }> {
    return { sha, treeSha: `tree-of-${sha}` };
  }

  async createBlob(repo: string, contentBase64: string): Promise<{ sha: string }> {
    this.writes.push({ op: "createBlob", args: { repo, contentBase64 } });
    return { sha: `blob-${this.gitSeq++}` };
  }

  async createTree(repo: string, baseTreeSha: string, entries: GitTreeEntry[]): Promise<{ sha: string }> {
    this.writes.push({ op: "createTree", args: { repo, baseTreeSha, entries } });
    return { sha: `tree-${this.gitSeq++}` };
  }

  async createCommit(repo: string, message: string, treeSha: string, parentShas: string[]): Promise<{ sha: string }> {
    this.writes.push({ op: "createCommit", args: { repo, message, treeSha, parentShas } });
    return { sha: `commit-${this.gitSeq++}` };
  }

  async updateRef(repo: string, branch: string, sha: string, force: boolean): Promise<void> {
    const key = `${repo}:${branch}`;
    if (!this.branchShas.has(key)) throw new Error(`github 422: ref not found: ${branch}`);
    this.writes.push({ op: "updateRef", args: { repo, branch, sha, force } });
    this.branchShas.set(key, sha);
  }

  async findPullRequestByHead(repo: string, head: string): Promise<{ number: number; url: string; draft: boolean } | null> {
    return this.openPrs.get(`${repo}:${head}`) ?? null;
  }

  async getPullRequest(
    repo: string,
    prNumber: number,
  ): Promise<{ number: number; url: string; headRef: string; draft: boolean; state: string } | null> {
    for (const [key, pr] of this.openPrs) {
      if (key.startsWith(`${repo}:`) && pr.number === prNumber) {
        return { number: pr.number, url: pr.url, headRef: key.slice(repo.length + 1), draft: pr.draft, state: "open" };
      }
    }
    return null;
  }

  async updatePullRequest(repo: string, prNumber: number, patch: { title?: string; body?: string }): Promise<void> {
    this.writes.push({ op: "updatePullRequest", args: { repo, prNumber, ...patch } });
    for (const pr of this.openPrs.values()) {
      if (pr.number === prNumber) Object.assign(pr, patch);
    }
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    this.writes.push({ op: "addLabels", args: { repo, issueNumber, labels } });
    const key = `${repo}:${issueNumber}`;
    this.labels.set(key, [...new Set([...(this.labels.get(key) ?? []), ...labels])]);
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    this.writes.push({ op: "removeLabel", args: { repo, issueNumber, label } });
    const key = `${repo}:${issueNumber}`;
    this.labels.set(key, (this.labels.get(key) ?? []).filter((l) => l !== label));
  }

  async setPullRequestDraft(repo: string, prNumber: number, draft: boolean): Promise<void> {
    this.writes.push({ op: "setPullRequestDraft", args: { repo, prNumber, draft } });
    for (const pr of this.openPrs.values()) {
      if (pr.number === prNumber) pr.draft = draft;
    }
  }
}
