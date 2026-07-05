/**
 * M0 automated demo (design.md / roadmap.md M0 exit criteria).
 *
 * Drives the foundations end-to-end with no manual steps:
 *   migrate -> create tenant/user/agent/version/task -> walk the task state
 *   machine -> assert final state, audit rows, and that an invalid transition
 *   is rejected. Prints "demo-m0 OK" on success, exits non-zero on failure.
 *
 * Requires Postgres reachable at DATABASE_URL (the Makefile brings it up).
 */
import { loadConfig } from "@marathon/config";
import type { TaskStatus } from "@marathon/core";
import { Database, migrate } from "@marathon/db";

async function main(): Promise<void> {
  const cfg = loadConfig();

  const applied = await migrate(cfg.databaseUrl);
  console.log(`[m0] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(cfg.databaseUrl);
  try {
    const tenant = await db.createTenant({ name: `demo-${Date.now()}` });
    const user = await db.createUser({
      tenantId: tenant.id,
      displayName: "Demo User",
      email: "demo@example.com",
      role: "admin",
    });
    const agent = await db.createAgent({
      tenantId: tenant.id,
      name: "bruce",
      displayName: "Bruce",
      ownerUserId: user.id,
    });
    const version = await db.createAgentVersion({
      agentId: agent.id,
      versionNumber: 1,
      instructions: "Investigate engineering issues.",
    });
    const task = await db.createTask({
      tenantId: tenant.id,
      agentId: agent.id,
      agentVersionId: version.id,
      invokingUserId: user.id,
      sourceType: "slack",
      sourceRef: { channel: "C123", thread_ts: "1700000000.000100" },
      inputText: "why did checkout errors increase today?",
    });
    await db.write({
      tenantId: tenant.id,
      actorUserId: user.id,
      eventType: "task.created",
      targetType: "task",
      targetId: task.id,
      summary: "task created",
    });

    const path: TaskStatus[] = ["queued", "running", "completed"];
    let current = task;
    for (const to of path) {
      current = await db.transitionTask(current.id, to);
      await db.write({
        tenantId: tenant.id,
        actorAgentId: agent.id,
        eventType: `task.${to}`,
        targetType: "task",
        targetId: task.id,
        summary: `task -> ${to}`,
      });
      console.log(`[m0] task ${task.id} -> ${current.status}`);
    }

    // assertions
    assert(current.status === "completed", `expected completed, got ${current.status}`);
    assert(current.startedAt !== null, "expected started_at to be stamped");
    assert(current.completedAt !== null, "expected completed_at to be stamped");

    const auditCount = await db.countAuditEvents(tenant.id);
    assert(auditCount >= 4, `expected >= 4 audit events, got ${auditCount}`);

    let rejected = false;
    try {
      await db.transitionTask(current.id, "running");
    } catch {
      rejected = true;
    }
    assert(rejected, "expected invalid transition completed -> running to be rejected");

    // Surface bindings (§2b #14): with a deployment name, Slack and GitHub
    // bootstraps land on ONE tenant; without one, each surface id keys its own.
    const dep = `dep-${Date.now()}`;
    const viaSlack = await db.findOrCreateTenantBySurface({
      surface: "slack", externalId: `T-${dep}`, name: dep, deployment: dep,
    });
    const viaGithub = await db.findOrCreateTenantBySurface({
      surface: "github", externalId: `owner-${dep}`, name: dep, deployment: dep,
    });
    assert(viaSlack.id === viaGithub.id, "expected both surfaces to bind to the deployment tenant");
    const rebound = await db.findOrCreateTenantBySurface({
      surface: "github", externalId: `owner-${dep}`, name: "other", deployment: undefined,
    });
    assert(rebound.id === viaSlack.id, "expected the existing binding to win over a fresh create");
    const standalone = await db.findOrCreateTenantBySurface({
      surface: "github", externalId: `owner2-${dep}`, name: dep,
    });
    assert(standalone.id !== viaSlack.id, "expected no deployment -> a fresh tenant per surface id");
    // Concurrent boots on a fresh deployment (both live apps at once, plus a
    // duplicate boot of one surface) must converge on ONE tenant — the loser
    // of the unique-index race re-resolves instead of failing the boot.
    const race = `race-${Date.now()}`;
    const raced = await Promise.all([
      db.findOrCreateTenantBySurface({ surface: "slack", externalId: `T-${race}`, name: race, deployment: race }),
      db.findOrCreateTenantBySurface({ surface: "github", externalId: `o-${race}`, name: race, deployment: race }),
      db.findOrCreateTenantBySurface({ surface: "github", externalId: `o-${race}`, name: race, deployment: race }),
    ]);
    assert(new Set(raced.map((t) => t.id)).size === 1, "expected concurrent boots to converge on one tenant");

    console.log(
      `[m0] tenant=${tenant.id} task=${task.id} audit_events=${auditCount}`,
    );
    console.log("demo-m0 OK");
  } finally {
    await db.close();
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

main().catch((err) => {
  console.error("demo-m0 FAILED:", err);
  process.exit(1);
});
