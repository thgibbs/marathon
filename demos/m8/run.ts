/**
 * M8 automated demo — inspectability, cost & budgets (deterministic, DB-backed).
 *   - seed a realistic task (step + model call + 2 tool calls + approval + audit)
 *   - the inspectability API returns a complete, ordered timeline + cost + failures
 *   - cost rollup (by model) and a metrics snapshot (incl. tool error rate)
 *   - budget: spend past a limit is detected and further spend is blocked
 *
 * Requires Postgres at DATABASE_URL.
 */
import { Database, migrate } from "@marathon/db";
import { assertWithinBudget, BudgetExceededError, checkBudget, getCostRollup, getMetrics, getTaskReport, getTaskTimeline } from "@marathon/observability";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[m8] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  try {
    const tenant = await db.createTenant({ name: `demo-m8-${Date.now()}` });
    const user = await db.createUser({ tenantId: tenant.id, role: "admin" });
    const agent = await db.createAgent({ tenantId: tenant.id, name: "bruce", ownerUserId: user.id });
    const task = await db.createTask({ tenantId: tenant.id, agentId: agent.id, invokingUserId: user.id, sourceType: "slack", inputText: "investigate checkout errors" });
    await db.transitionTask(task.id, "queued");
    await db.transitionTask(task.id, "running");

    // --- seed a realistic task trace ---
    await db.completeStep(task.id, "load_context", { completedSteps: ["load_context"], findings: [] }, [
      { provider: "openai", model: "gpt-4o-mini", promptVersion: "bruce@1", inputTokens: 1200, outputTokens: 300, costUsd: 0.002, status: "ok" },
    ]);
    await db.recordToolInvocation({ taskId: task.id, toolId: "github.read_file", status: "ok", riskLevel: "low", inputSummary: "repo=o/r path=README.md", outputSummary: "120 lines" });
    await db.recordToolInvocation({ taskId: task.id, toolId: "github.merge_pull_request", status: "error", riskLevel: "high", error: "blocked pending approval" });
    await db.createApprovalRequest({ tenantId: tenant.id, taskId: task.id, actionSummary: "merge PR #7", riskLevel: "high" });
    await db.write({ tenantId: tenant.id, eventType: "task.completed", summary: "investigation complete", targetType: "task", targetId: task.id });
    await db.transitionTask(task.id, "completed");

    // --- 1. inspectability: the task report / timeline (tenant-scoped) ---
    const report = (await getTaskReport(db, tenant.id, task.id))!;
    assert(report.status === "completed", "report reflects task status");
    assert(report.modelCalls === 1 && report.toolCalls === 2, `expected 1 model + 2 tool calls, got ${report.modelCalls}/${report.toolCalls}`);
    assert(Math.abs(report.costUsd - 0.002) < 1e-6, `cost should be ~0.002, got ${report.costUsd}`);
    assert(report.promptVersions.includes("bruce@1"), "prompt version surfaced");
    assert(report.failures.some((e) => e.type === "tool_call"), "the failed merge appears in failures");
    assert(["step", "model_call", "tool_call", "approval", "audit"].every((t) => report.timeline.some((e) => e.type === t)), "timeline includes every event type");
    // timeline is time-ordered
    const times = report.timeline.map((e) => e.at.getTime());
    assert(times.every((t, i) => i === 0 || t >= times[i - 1]!), "timeline is chronological");
    console.log(`[m8] task report: ${report.timeline.length} events, $${report.costUsd.toFixed(4)}, ${report.failures.length} failure(s)`);

    // tenant isolation: another tenant cannot read this task's report/timeline
    const other = await db.createTenant({ name: `demo-m8-other-${Date.now()}` });
    assert((await getTaskReport(db, other.id, task.id)) === null, "cross-tenant report read must be denied");
    assert((await getTaskTimeline(db, other.id, task.id)).length === 0, "cross-tenant timeline read must be denied");
    console.log("[m8] cross-tenant report/timeline read -> denied");

    // --- 2. cost rollup + metrics ---
    const byModel = await getCostRollup(db, tenant.id, "model");
    assert(byModel.some((r) => r.key === "openai:gpt-4o-mini" && r.costUsd > 0), "cost rolled up by model");
    const metrics = await getMetrics(db, tenant.id);
    assert((metrics.tasksByStatus.completed ?? 0) >= 1, "metrics count the completed task");
    assert(Math.abs(metrics.toolErrorRate - 0.5) < 1e-6, `tool error rate should be 0.5, got ${metrics.toolErrorRate}`);
    console.log(`[m8] rollup: ${byModel.map((r) => `${r.key}=$${r.costUsd.toFixed(4)}`).join(", ")}; toolErrorRate=${metrics.toolErrorRate}`);

    // --- 3. budget enforcement ---
    const ok = await checkBudget(db, { tenantId: tenant.id }, { limitUsd: 1.0 });
    assert(ok.state === "ok", "well under a $1 budget");
    const over = await checkBudget(db, { tenantId: tenant.id }, { limitUsd: 0.001 });
    assert(over.state === "exceeded", "spend exceeds a $0.001 budget");

    let blocked = false;
    try {
      await assertWithinBudget(db, { tenantId: tenant.id }, { limitUsd: 0.001 });
    } catch (e) {
      blocked = e instanceof BudgetExceededError;
    }
    assert(blocked, "further spend is blocked once the budget is exceeded");
    console.log(`[m8] budget: $${over.spentUsd.toFixed(4)} spent -> exceeded $0.001 limit -> next turn blocked`);

    console.log("demo-m8 OK");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("demo-m8 FAILED:", err);
  process.exit(1);
});
