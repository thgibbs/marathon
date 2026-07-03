import type { SecretStore } from "@marathon/config";
import { FakeCommandRunner, ToolGateway, ToolRegistry, type ToolContext } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import { DEFAULT_GH_FAMILIES, makeGithubExecTool, makeGitExecTool } from "../src/exec-tools";

const TOKEN = "ghp_" + "x".repeat(36);
const secrets: SecretStore = { get: async (ref) => (ref === "secret/github" ? TOKEN : undefined) };
const ctx: ToolContext = { taskId: "task-1", tenantId: "tenant-1", secrets };

describe("github.exec (Track 6 broker)", () => {
  const make = (runner: FakeCommandRunner) =>
    makeGithubExecTool({ allowedRepos: ["acme/service"], runner });

  describe("validate", () => {
    const tool = make(new FakeCommandRunner());
    const invalid = (argv: unknown) => tool.validate?.({ argv });

    it("requires a non-empty string argv", () => {
      expect(invalid(undefined)).toMatch(/argv/);
      expect(invalid([])).toMatch(/argv/);
      expect(invalid(["pr", 1])).toMatch(/only strings/);
    });

    it("allows only the allowlisted gh families", () => {
      expect(invalid(["pr", "merge", "1", "--repo", "acme/service"])).toMatch(/not in an allowlisted gh family/);
      expect(invalid(["repo", "delete", "acme/service"])).toMatch(/not in an allowlisted gh family/);
      expect(invalid(["pr", "view", "1", "--repo", "acme/service"])).toBeNull();
      expect(invalid(["pr", "diff", "1", "--repo", "acme/service"])).toBeNull();
      expect(invalid(["issue", "view", "9", "--repo", "acme/service"])).toBeNull();
      expect(invalid(["repo", "view", "acme/service"])).toBeNull();
      expect(invalid(["pr", "create", "--repo", "acme/service", "--title", "t", "--body", "b"])).toBeNull();
      expect(invalid(["pr", "edit", "2", "--repo", "acme/service", "--title", "t"])).toBeNull();
    });

    it("tolerates a leading 'gh'", () => {
      expect(invalid(["gh", "pr", "view", "1", "--repo", "acme/service"])).toBeNull();
    });

    it("requires an explicit repo in the allowlist", () => {
      expect(invalid(["pr", "view", "1"])).toMatch(/name the repo explicitly/);
      expect(invalid(["pr", "view", "1", "--repo", "evil/repo"])).toMatch(/repo not allowed/);
      expect(invalid(["repo", "view"])).toMatch(/name the repo explicitly/);
    });

    it("keeps gh api read-only and repo-scoped", () => {
      expect(invalid(["api", "repos/acme/service/pulls/1"])).toBeNull();
      expect(invalid(["api", "/repos/acme/service/pulls/1"])).toBeNull();
      expect(invalid(["api", "repos/evil/repo/pulls"])).toMatch(/repo not allowed/);
      expect(invalid(["api", "user"])).toMatch(/name the repo explicitly/);
      expect(invalid(["api", "repos/acme/service/pulls", "--method", "POST"])).toMatch(/read-only/);
      expect(invalid(["api", "repos/acme/service/pulls", "-X", "DELETE"])).toMatch(/read-only/);
      expect(invalid(["api", "repos/acme/service/pulls", "-f", "title=x"])).toMatch(/read-only/);
      expect(invalid(["api", "repos/acme/service/pulls", "--field=title=x"])).toMatch(/read-only/);
      expect(invalid(["api", "repos/acme/service/pulls", "--method", "GET"])).toBeNull();
    });
  });

  describe("source ledger / egress hooks", () => {
    const tool = make(new FakeCommandRunner());

    it("declares reads as sources and writes as egress", () => {
      expect(tool.sources?.({ argv: ["pr", "view", "1", "--repo", "acme/service"] })).toEqual([
        { source: "github:acme/service", sensitivity: "company_viewable" },
      ]);
      expect(tool.egress?.({ argv: ["pr", "view", "1", "--repo", "acme/service"] })).toBeNull();
      expect(tool.egress?.({ argv: ["pr", "create", "--repo", "acme/service"] })).toEqual({
        destination: "github:acme/service",
        audience: "tenant",
        external: false,
      });
      expect(tool.sources?.({ argv: ["pr", "create", "--repo", "acme/service"] })).toEqual([]);
      expect(tool.sources?.({ argv: ["nope"] })).toEqual([]);
      expect(tool.egress?.({ argv: ["nope"] })).toBeNull();
    });
  });

  describe("execute", () => {
    it("injects the credential into the child env only — never into the result", async () => {
      const runner = new FakeCommandRunner(() => ({ exitCode: 0, stdout: '{"title":"hi"}', stderr: "" }));
      const tool = make(runner);
      const res = await tool.execute({ argv: ["pr", "view", "1", "--repo", "acme/service", "--json", "title"] }, ctx);

      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.bin).toBe("gh");
      expect(call.argv).toEqual(["pr", "view", "1", "--repo", "acme/service", "--json", "title"]);
      expect(call.opts.env?.GH_TOKEN).toBe(TOKEN);
      expect(call.opts.env?.GH_PROMPT_DISABLED).toBe("1");
      // The token appears nowhere the model (or the trace) can see.
      expect(JSON.stringify({ content: res.content, details: res.details })).not.toContain(TOKEN);
      expect(res.content).toBe('{"title":"hi"}');
      expect(res.details).toMatchObject({ command: "gh", exit_code: 0, ok: true });
    });

    it("returns non-zero exits as data for the agent", async () => {
      const runner = new FakeCommandRunner(() => ({ exitCode: 1, stdout: "", stderr: "no pull requests found" }));
      const tool = make(runner);
      const res = await tool.execute({ argv: ["pr", "view", "99", "--repo", "acme/service"] }, ctx);
      expect(res.content).toContain("gh exited 1");
      expect(res.content).toContain("no pull requests found");
      expect(res.details).toMatchObject({ exit_code: 1, ok: false });
    });

    it("strips a leading 'gh' before running", async () => {
      const runner = new FakeCommandRunner(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
      const tool = make(runner);
      await tool.execute({ argv: ["gh", "pr", "view", "1", "--repo", "acme/service"] }, ctx);
      expect(runner.calls[0]?.argv[0]).toBe("pr");
    });

    it("fails when no token is configured", async () => {
      const tool = make(new FakeCommandRunner());
      const noSecrets: SecretStore = { get: async () => undefined };
      await expect(tool.execute({ argv: ["pr", "view", "1", "--repo", "acme/service"] }, { ...ctx, secrets: noSecrets })).rejects.toThrow(
        /no github token/,
      );
    });

    it("caps oversized output", async () => {
      const runner = new FakeCommandRunner(() => ({ exitCode: 0, stdout: "y".repeat(50), stderr: "" }));
      const tool = makeGithubExecTool({ allowedRepos: ["acme/service"], runner, maxOutputChars: 10 });
      const res = await tool.execute({ argv: ["pr", "view", "1", "--repo", "acme/service"] }, ctx);
      expect(res.content).toContain("… (output truncated)");
    });
  });

  it("is denied like any tool when ungranted, and blocked families never reach the runner", async () => {
    const runner = new FakeCommandRunner();
    const gateway = new ToolGateway({
      registry: new ToolRegistry([make(runner)]),
      policy: { grants: [{ tool: "github.exec" }] },
      secrets,
    });
    await expect(
      gateway.run("github.exec", { argv: ["pr", "merge", "1", "--repo", "acme/service"] }, { taskId: "t", tenantId: "tn" }),
    ).rejects.toThrow(/not in an allowlisted gh family/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("git.exec (Track 6 broker)", () => {
  const make = (runner: FakeCommandRunner, dir: string | null = "/ws/task-1") =>
    makeGitExecTool({
      allowedRepos: ["acme/service"],
      resolveWorkspaceDir: () => dir,
      runner,
    });

  describe("validate", () => {
    const tool = make(new FakeCommandRunner());
    const invalid = (argv: unknown) => tool.validate?.({ argv });

    it("allows only push and fetch on an allowlisted repo", () => {
      expect(invalid(["push", "acme/service", "HEAD:refs/heads/marathon/x"])).toBeNull();
      expect(invalid(["fetch", "acme/service", "main"])).toBeNull();
      expect(invalid(["git", "push", "acme/service", "HEAD:refs/heads/x"])).toBeNull();
      expect(invalid(["clone", "acme/service", "x"])).toMatch(/argv must be/);
      expect(invalid(["push", "evil/repo", "HEAD:x"])).toMatch(/repo not allowed/);
      expect(invalid(["push"])).toMatch(/argv must be/);
      expect(invalid(["push", "not-a-repo", "HEAD:x"])).toMatch(/argv must be/);
      expect(invalid([])).toMatch(/argv/);
      expect(invalid(["push", "acme/service", 3])).toMatch(/only strings/);
    });

    it("requires a refspec and refuses flags (no --force)", () => {
      expect(invalid(["push", "acme/service"])).toMatch(/refspec/);
      expect(invalid(["push", "acme/service", "--force", "HEAD:x"])).toMatch(/flags are not allowed/);
      expect(invalid(["push", "acme/service", "HEAD:x", "-f"])).toMatch(/flags are not allowed/);
    });
  });

  it("declares push as egress and fetch as a source read", () => {
    const tool = make(new FakeCommandRunner());
    expect(tool.egress?.({ argv: ["push", "acme/service", "HEAD:x"] })).toEqual({
      destination: "github:acme/service",
      audience: "tenant",
      external: false,
    });
    expect(tool.egress?.({ argv: ["fetch", "acme/service", "main"] })).toBeNull();
    expect(tool.sources?.({ argv: ["fetch", "acme/service", "main"] })).toEqual([
      { source: "github:acme/service", sensitivity: "company_viewable" },
    ]);
    expect(tool.sources?.({ argv: ["push", "acme/service", "HEAD:x"] })).toEqual([]);
  });

  it("runs in the task workspace with the credential in env, not argv", async () => {
    const runner = new FakeCommandRunner(() => ({ exitCode: 0, stdout: "", stderr: "To github.com:acme/service" }));
    const tool = make(runner);
    const res = await tool.execute({ argv: ["push", "acme/service", "HEAD:refs/heads/marathon/x"] }, ctx);

    const call = runner.calls[0]!;
    expect(call.bin).toBe("git");
    expect(call.argv.slice(0, 2)).toEqual(["-C", "/ws/task-1"]);
    expect(call.argv).toContain("push");
    expect(call.argv).toContain("https://github.com/acme/service.git");
    expect(call.argv.join(" ")).not.toContain(TOKEN);
    expect(call.opts.env?.MARATHON_GIT_TOKEN).toBe(TOKEN);
    expect(call.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(res.details).toMatchObject({ command: "git", argv: ["push", "acme/service", "HEAD:refs/heads/marathon/x"], ok: true });
  });

  it("supports a custom remote URL (demos push to local repos)", async () => {
    const runner = new FakeCommandRunner();
    const tool = makeGitExecTool({
      allowedRepos: ["acme/service"],
      resolveWorkspaceDir: () => "/ws",
      runner,
      remoteUrl: (repo) => `/local/${repo}.git`,
    });
    await tool.execute({ argv: ["push", "acme/service", "HEAD:x"] }, ctx);
    expect(runner.calls[0]?.argv).toContain("/local/acme/service.git");
  });

  it("reports non-zero exits as data", async () => {
    const runner = new FakeCommandRunner(() => ({ exitCode: 128, stdout: "", stderr: "fatal: rejected" }));
    const tool = make(runner);
    const res = await tool.execute({ argv: ["push", "acme/service", "HEAD:x"] }, ctx);
    expect(res.content).toContain("git push exited 128");
    expect(res.content).toContain("fatal: rejected");
    expect(res.details).toMatchObject({ exit_code: 128, ok: false });
  });

  it("refuses outside a BUILD stage (no bound workspace)", async () => {
    const tool = make(new FakeCommandRunner(), null);
    await expect(tool.execute({ argv: ["push", "acme/service", "HEAD:x"] }, ctx)).rejects.toThrow(/NO_WORKSPACE/);
  });

  it("fails when no token is configured", async () => {
    const tool = make(new FakeCommandRunner());
    const noSecrets: SecretStore = { get: async () => undefined };
    await expect(tool.execute({ argv: ["push", "acme/service", "HEAD:x"] }, { ...ctx, secrets: noSecrets })).rejects.toThrow(
      /no github token/,
    );
  });
});
