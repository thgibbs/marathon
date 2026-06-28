/**
 * M6.1 automated demo — governed tools in the agent loop (deterministic).
 *
 * A scripted tool-using agent runs its tool calls through runGovernedTool (the
 * Tool Gateway = embedded permissioning). A read tool is allowed and audited; a
 * destructive tool surfaces approval_required, which drives the block-persist-
 * resume approval, and after approval executes EXACTLY once.
 *
 * The real Pi wiring (custom tools -> gateway) is verified by `make smoke-pi-tools`.
 * Requires Postgres at DATABASE_URL.
 */
import { runGovernedTool } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, makeGithubReadTools, makeGithubWriteTools } from "@marathon/connector-github";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { ApprovalService, executeApproved, proposeToolCall } from "@marathon/worker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const REPO = "o/repo";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[m6.1] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  const queue = new Queue(url);
  try {
    const tenant = await db.createTenant({ name: `demo-m6.1-${Date.now()}` });
    const agent = await db.createAgent({ tenantId: tenant.id, name: "bruce" });
    const task = await db.createTask({ tenantId: tenant.id, agentId: agent.id, sourceType: "slack", inputText: "investigate + maybe merge" });
    await db.transitionTask(task.id, "queued");
    await db.transitionTask(task.id, "running");

    const gh = new FixturesGithubClient({ files: { [`${REPO}:README.md`]: { path: "README.md", content: "# demo" } } });
    const gateway = new ToolGateway({
      registry: new ToolRegistry([...makeGithubReadTools(() => gh), ...makeGithubWriteTools(() => gh)]),
      policy: { grants: [{ tool: "github.read_file" }, { tool: "github.merge_pull_request" }] } as ToolPolicy,
      secrets: new EnvSecretStore({ GITHUB_TOKEN: "ghp_SENTINEL000000000000000000000000000" }),
      recorder: {
        onInvocation: (r) => db.recordToolInvocation({ taskId: r.taskId, toolId: r.toolName, status: r.status, riskLevel: r.riskLevel, inputSummary: r.inputSummary, outputSummary: r.outputSummary, error: r.error }),
        onAudit: (e) => void db.write({ tenantId: e.tenantId, eventType: e.eventType, summary: e.summary, targetType: e.targetType, targetId: e.targetId }),
      },
    });
    const ctx = { taskId: task.id, tenantId: tenant.id, agentId: agent.id };
    const approvals = new ApprovalService(db);

    // 1. agent calls a governed read tool -> allowed
    const read = await runGovernedTool(gateway, "github.read_file", { repo: REPO, path: "README.md" }, ctx);
    assert(read.status === "ok", `read should be ok, got ${read.status}`);
    console.log("[m6.1] governed github.read_file -> ok (policy + audit applied)");

    // 2. agent proposes a destructive tool -> approval_required
    const merge = await runGovernedTool(gateway, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx);
    assert(merge.status === "approval_required", `merge should require approval, got ${merge.status}`);
    console.log("[m6.1] governed github.merge_pull_request -> approval_required");

    // 3. drive the durable approval, then execute exactly once
    const proposal = await proposeToolCall(gateway, approvals, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx, { actionSummary: "merge PR #7", riskLevel: "high" });
    assert(proposal.status === "pending", "merge should create a pending approval");
    const approvalId = proposal.status === "pending" ? proposal.approvalId : "";
    await approvals.approve(approvalId);
    const exec1 = await executeApproved(gateway, db, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx);
    const exec2 = await executeApproved(gateway, db, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx);
    assert(exec1.executed && !exec2.executed, "approved merge must execute exactly once");
    assert(gh.writes.filter((w) => w.op === "mergePullRequest").length === 1, "exactly one merge");
    console.log("[m6.1] approved -> merged exactly once");

    // 4. credentials never leak into the recorded trace
    const summaries = await db.toolInvocationSummaries(task.id);
    assert(!summaries.some((s) => s.includes("ghp_SENTINEL")), "no credentials in the tool trace");

    console.log(`[m6.1] task=${task.id} tools_audited=${await db.countToolInvocations(task.id)} approvals=${await db.countApprovalsByStatus(tenant.id, "approved")}`);
    console.log("demo-m6.1 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-m6.1 FAILED:", err);
  process.exit(1);
});
