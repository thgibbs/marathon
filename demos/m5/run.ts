/**
 * M5 automated demo (roadmap.md M5 exit criteria).
 *
 *   - non-destructive write (create_issue)     -> executes autonomously, no approval
 *   - destructive write (merge_pull_request)   -> waiting_for_approval, NOT executed
 *   - simulate a worker restart during the wait -> approval still pending (durable)
 *   - approve                                  -> executes EXACTLY ONCE
 *   - approve-execute again (retry)            -> no double execution (idempotency)
 *   - separate task: reject                    -> not executed
 *   - separate task: expire                    -> approval expired, task resumed
 *
 * Deterministic (fixtures) — no network/keys. Real GitHub writes are verified via
 * `make smoke-github-write`. Requires Postgres at DATABASE_URL.
 */
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, makeGithubWriteTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { ApprovalService, executeApproved, proposeToolCall } from "@marathon/worker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const REPO = "o/repo";

async function main(): Promise<void> {
  const applied = await migrate();
  console.log(`[m5] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon");
  try {
    const tenant = await db.createTenant({ name: `demo-m5-${Date.now()}` });
    const user = await db.createUser({ tenantId: tenant.id, role: "admin" });
    const agent = await db.createAgent({ tenantId: tenant.id, name: "linus", ownerUserId: user.id });

    const gh = new FixturesGithubClient({});
    const registry = new ToolRegistry(makeGithubWriteTools(() => gh));
    const policy: ToolPolicy = {
      grants: [{ tool: "github.create_issue" }, { tool: "github.merge_pull_request" }],
    };
    const recorder = dbToolRecorder(db);
    const gateway = new ToolGateway({ registry, policy, secrets: new EnvSecretStore({}), recorder });
    const approvals = new ApprovalService(db);

    const newRunningTask = async () => {
      const t = await db.createTask({ tenantId: tenant.id, agentId: agent.id, sourceType: "slack", inputText: "do work" });
      await db.transitionTask(t.id, "queued");
      await db.transitionTask(t.id, "running");
      return t;
    };

    // 1) non-destructive write executes autonomously
    const t1 = await newRunningTask();
    const ctx1 = { taskId: t1.id, tenantId: tenant.id, agentId: agent.id };
    const r1 = await proposeToolCall(gateway, approvals, "github.create_issue", { repo: REPO, title: "hello" }, ctx1, { actionSummary: "open an issue" });
    assert(r1.status === "executed", `create_issue should execute, got ${r1.status}`);
    assert((await db.getTask(t1.id))!.status === "running", "task should stay running (no approval)");
    console.log("[m5] create_issue (non-destructive) -> executed autonomously");

    // 2) destructive write requires approval
    const t2 = await newRunningTask();
    const ctx2 = { taskId: t2.id, tenantId: tenant.id, agentId: agent.id };
    const r2 = await proposeToolCall(gateway, approvals, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx2, { actionSummary: "merge PR #7", riskLevel: "high" });
    assert(r2.status === "pending", `merge should be pending, got ${r2.status}`);
    const approvalId = r2.status === "pending" ? r2.approvalId : "";
    assert((await db.getTask(t2.id))!.status === "waiting_for_approval", "task should be waiting_for_approval");
    assert(gh.writes.filter((w) => w.op === "mergePullRequest").length === 0, "merge must NOT have executed yet");
    console.log("[m5] merge_pull_request (destructive) -> waiting_for_approval, not executed");

    // 3) simulate worker restart: re-read from db (state is durable)
    const reloaded = await db.getApprovalRequest(approvalId);
    assert(reloaded?.status === "pending", "approval should still be pending after 'restart'");
    assert((await db.getTask(t2.id))!.status === "waiting_for_approval", "wait survives restart");
    console.log("[m5] (simulated restart) approval still pending, task still waiting");

    // 4) approve -> execute exactly once
    await approvals.approve(approvalId, user.id);
    assert((await db.getTask(t2.id))!.status === "running", "task resumes to running after approve");
    const exec1 = await executeApproved(gateway, db, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx2);
    assert(exec1.executed, "approved merge should execute");
    // 5) retry the approved execution -> idempotent (no double execute)
    const exec2 = await executeApproved(gateway, db, "github.merge_pull_request", { repo: REPO, number: 7 }, ctx2);
    assert(!exec2.executed, "second execute must be a no-op (idempotency)");
    assert(gh.writes.filter((w) => w.op === "mergePullRequest").length === 1, "merge must execute EXACTLY once");
    console.log("[m5] approved -> merged exactly once (idempotent on retry)");

    // 6) reject path
    const t3 = await newRunningTask();
    const ctx3 = { taskId: t3.id, tenantId: tenant.id, agentId: agent.id };
    const r3 = await proposeToolCall(gateway, approvals, "github.merge_pull_request", { repo: REPO, number: 9 }, ctx3, { actionSummary: "merge PR #9", riskLevel: "high" });
    await approvals.reject(r3.status === "pending" ? r3.approvalId : "", user.id);
    assert((await db.getTask(t3.id))!.status === "running", "task resumes after reject");
    assert(gh.writes.filter((w) => w.op === "mergePullRequest" && (w.args as { prNumber?: number }).prNumber === 9).length === 0, "rejected merge must NOT execute");
    console.log("[m5] rejected -> not executed");

    // 7) expiration path
    const t4 = await newRunningTask();
    const ctx4 = { taskId: t4.id, tenantId: tenant.id, agentId: agent.id };
    await proposeToolCall(gateway, approvals, "github.merge_pull_request", { repo: REPO, number: 11 }, ctx4, { actionSummary: "merge PR #11", riskLevel: "high", expiresInMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const expired = await approvals.expireDue(new Date(Date.now() + 1000));
    assert(expired >= 1, "at least one approval should expire");
    assert((await db.getTask(t4.id))!.status === "running", "task resumes after expiry");
    console.log("[m5] expired -> approval expired, task resumed");

    // --- summary assertions ---
    const approved = await db.countApprovalsByStatus(tenant.id, "approved");
    const rejected = await db.countApprovalsByStatus(tenant.id, "rejected");
    const expiredCount = await db.countApprovalsByStatus(tenant.id, "expired");
    assert(approved === 1 && rejected === 1 && expiredCount === 1, `approvals a/r/e = ${approved}/${rejected}/${expiredCount}`);

    console.log(`[m5] approvals: approved=${approved} rejected=${rejected} expired=${expiredCount}; merges=${gh.writes.filter((w) => w.op === "mergePullRequest").length}`);
    console.log("demo-m5 OK");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("demo-m5 FAILED:", err);
  process.exit(1);
});
