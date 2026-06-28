/**
 * M3 automated demo (roadmap.md M3 exit criteria).
 *
 * An agent task uses tools through the Tool Gateway (embedded permissioning):
 *   - a CLI tool (echo) under an allowlist           -> allowed
 *   - github.read_file on a granted, allowed repo     -> allowed (fixtures)
 *   - github.list_contents (NOT granted)              -> blocked + audited
 *   - github.read_file on a disallowed repo           -> blocked (constraint)
 * Asserts: ToolInvocation rows, policy.denied audits, and that NO credential
 * material appears in the recorded trace.
 *
 * Deterministic (fixtures + echo) — no network/keys. The real GitHub connector
 * is verified locally via `make smoke-github`. Requires Postgres at DATABASE_URL.
 */
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, makeGithubReadTools } from "@marathon/connector-github";
import { Database, migrate } from "@marathon/db";
import {
  LocalSubprocessSandbox,
  makeCliTool,
  ToolBlockedError,
  ToolGateway,
  ToolRegistry,
  type AuditRecord,
  type ToolInvocationRecord,
  type ToolPolicy,
} from "@marathon/tools";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const SENTINEL_TOKEN = "ghp_SENTINEL0000000000000000000000000000";

async function main(): Promise<void> {
  const applied = await migrate();
  console.log(`[m3] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon");
  try {
    const tenant = await db.createTenant({ name: `demo-m3-${Date.now()}` });
    const user = await db.createUser({ tenantId: tenant.id, role: "admin" });
    const agent = await db.createAgent({ tenantId: tenant.id, name: "bruce", ownerUserId: user.id });
    const task = await db.createTask({
      tenantId: tenant.id,
      agentId: agent.id,
      invokingUserId: user.id,
      sourceType: "slack",
      inputText: "use some tools",
    });

    // fixtures GitHub client (no network); token is a sentinel we assert is never logged
    const ghClient = new FixturesGithubClient({
      files: { "o/repo:README.md": { path: "README.md", content: "# agentp-demo\n" } },
      contents: { "o/repo:": [{ name: "README.md", type: "file", path: "README.md" }] },
    });
    const registry = new ToolRegistry([
      makeCliTool(["echo"], new LocalSubprocessSandbox()),
      ...makeGithubReadTools(() => ghClient),
    ]);

    // policy: grant cli.run + github.read_file (only on o/repo). github.list_contents NOT granted.
    const policy: ToolPolicy = {
      grants: [{ tool: "cli.run" }, { tool: "github.read_file", constraints: { allowedRepos: ["o/repo"] } }],
    };

    const recorder = {
      onInvocation: (r: ToolInvocationRecord) =>
        db.recordToolInvocation({
          taskId: r.taskId,
          toolId: r.toolName,
          status: r.status,
          riskLevel: r.riskLevel,
          inputSummary: r.inputSummary,
          outputSummary: r.outputSummary,
          error: r.error,
        }),
      onAudit: (e: AuditRecord) =>
        db.write({
          tenantId: e.tenantId,
          eventType: e.eventType,
          summary: e.summary,
          targetType: e.targetType,
          targetId: e.targetId,
          actorAgentId: e.actorAgentId,
        }),
    };

    const gateway = new ToolGateway({
      registry,
      policy,
      secrets: new EnvSecretStore({ GITHUB_TOKEN: SENTINEL_TOKEN }),
      recorder,
    });
    const ctx = { taskId: task.id, tenantId: tenant.id, agentId: agent.id };

    // 1. allowed CLI tool
    const cli = await gateway.run("cli.run", { command: "echo hello-marathon" }, ctx);
    assert(cli.content.trim() === "hello-marathon", "cli.run should echo");
    console.log("[m3] cli.run echo -> allowed");

    // 2. allowed github read (granted + allowed repo)
    const file = await gateway.run("github.read_file", { repo: "o/repo", path: "README.md" }, ctx);
    assert(file.content.includes("agentp-demo"), "github.read_file should return content");
    console.log("[m3] github.read_file (granted repo) -> allowed");

    // 3. ungranted tool -> blocked
    let blockedUngranted = false;
    try {
      await gateway.run("github.list_contents", { repo: "o/repo" }, ctx);
    } catch (e) {
      blockedUngranted = e instanceof ToolBlockedError;
    }
    assert(blockedUngranted, "ungranted github.list_contents should be blocked");
    console.log("[m3] github.list_contents (ungranted) -> blocked");

    // 4. constraint violation -> blocked
    let blockedRepo = false;
    try {
      await gateway.run("github.read_file", { repo: "o/secret", path: "README.md" }, ctx);
    } catch (e) {
      blockedRepo = e instanceof ToolBlockedError;
    }
    assert(blockedRepo, "github.read_file on disallowed repo should be blocked");
    console.log("[m3] github.read_file (disallowed repo) -> blocked");

    // --- assertions ---
    const toolCount = await db.countToolInvocations(task.id);
    assert(toolCount === 4, `expected 4 tool invocations, got ${toolCount}`);
    const denied = await db.countAuditByType(tenant.id, "policy.denied");
    assert(denied === 2, `expected 2 policy.denied audits, got ${denied}`);
    const called = await db.countAuditByType(tenant.id, "tool.called");
    assert(called === 2, `expected 2 tool.called audits, got ${called}`);

    const summaries = await db.toolInvocationSummaries(task.id);
    const leaked = summaries.some((s) => s.includes(SENTINEL_TOKEN));
    assert(!leaked, "credential material must never appear in the tool trace");

    console.log(
      `[m3] task=${task.id} tools=${toolCount} (2 ok, 2 blocked) denied_audits=${denied} creds_in_trace=${leaked}`,
    );
    console.log("demo-m3 OK");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("demo-m3 FAILED:", err);
  process.exit(1);
});
