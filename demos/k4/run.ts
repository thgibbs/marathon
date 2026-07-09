/**
 * K4 automated demo (roadmap §2c): durable resume of a code-writing BUILD run.
 *
 *   - an implementation task (plan_ref/base_sha pinned, §29.1) starts its BUILD
 *     stage: a multi-turn run editing a real git workspace, checkpointing after
 *     every completed turn (session/turn index + workspace diff vs base_sha);
 *   - worker #1 is KILLED mid-run (after turn 1's checkpoint) — the lease is
 *     abandoned, exactly like a process death;
 *   - after the visibility timeout, worker #2 reclaims the job and RESUMES:
 *     fresh workspace at base_sha + the checkpointed diff replayed, no turn
 *     re-run, and the run completes through `github.submit_code_changes`;
 *   - asserts: completed turns ran exactly once, the replayed diff carried the
 *     earlier edits, exactly ONE PR exists (at-most-once effects), the task
 *     completed, and per-turn steps/cost were recorded.
 *
 * Prints "demo-k4 OK" on success; exits non-zero on failure.
 * Requires Postgres reachable at DATABASE_URL (make db-up).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ScriptedBuildRuntime, type ScriptedBuildTurn } from "@marathon/agent";
import { CodeTaskRegistry, InMemoryCodeChangeStore } from "@marathon/code-handoff";
import { loadConfig } from "@marathon/config";
import { FixturesGithubClient, makeGithubCodeTools } from "@marathon/connector-github";
import type { VerificationResult } from "@marathon/core";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { ToolGateway, ToolRegistry } from "@marathon/tools";
import { makeBuildStepRunner, Orchestrator, parseCheckpoint, Worker } from "@marathon/worker";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await migrate(cfg.databaseUrl);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);

  // --- 1. A local fixture repo whose HEAD is the "merged plan" commit (§29.1). ---
  const REPO = "acme/service";
  const origin = await mkdtemp(join(tmpdir(), "marathon-k4-origin-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", origin, ...args]);
  await execFileAsync("git", ["init", "--quiet", origin]);
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@test");
  await writeFile(join(origin, "greet.mjs"), `export const greet = () => "hi";\n`);
  await writeFile(
    join(origin, "test.mjs"),
    `import { greet } from "./greet.mjs";\nif (greet("Ada") !== "hi Ada") { console.error("greet must include the name"); process.exit(1); }\nconsole.log("ok");\n`,
  );
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "plan: greet by name (merged)");
  const approvedSha = (await git("rev-parse", "HEAD")).stdout.trim();

  // --- 2. The BUILD-stage machinery shared by both workers (§29.4). ---
  const client = new FixturesGithubClient({});
  const store = new InMemoryCodeChangeStore();
  const registry = new CodeTaskRegistry();
  const gateway = new ToolGateway({
    registry: new ToolRegistry(makeGithubCodeTools({ getClient: () => client, registry, store })),
    policy: { grants: [{ tool: "github.submit_code_changes" }] },
    secrets: { get: async () => null } as never,
  });

  // The scripted BUILD run: 3 turns, each checkpointed. Counters prove
  // exactly-once execution across the kill/resume boundary.
  const ran: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  let verification: VerificationResult[] = [];
  const turns: ScriptedBuildTurn[] = [
    async ({ workspace }) => {
      ran[0] = (ran[0] ?? 0) + 1;
      await writeFile(join(workspace!.dir, "greet.mjs"), `export const greet = (name) => \`hi \${name}\`;\n`);
      return "implemented greet-by-name";
    },
    async ({ workspace }) => {
      ran[1] = (ran[1] ?? 0) + 1;
      const r = await execFileAsync("node", ["test.mjs"], { cwd: workspace!.dir }).then(
        (o) => ({ exitCode: 0, out: o.stdout }),
        (e: { code?: number; stderr?: string }) => ({ exitCode: e.code ?? 1, out: e.stderr ?? "" }),
      );
      verification = [{ command: "node test.mjs", exitCode: r.exitCode, summary: r.out.trim().slice(0, 200) }];
      return `verified: exit ${r.exitCode}`;
    },
    async ({ workspace, request }) => {
      ran[2] = (ran[2] ?? 0) + 1;
      // Resume replay proof: turn 0's edit must be in the RE-MATERIALIZED workspace.
      const greet = await readFile(join(workspace!.dir, "greet.mjs"), "utf8");
      if (!greet.includes("hi ${name}")) throw new Error("checkpointed diff was not replayed");
      await gateway.run(
        "github.submit_code_changes",
        {
          title: "Greet by name",
          summary: "greet() now includes the caller's name, per the merged plan.",
          plan_ref: { repo: REPO, doc_path: "docs/plan.md", merge_commit_sha: approvedSha },
          verification: verification.map((v) => ({ command: v.command, exit_code: v.exitCode, summary: v.summary })),
        },
        { taskId: request.taskId, tenantId: request.tenantId ?? "" },
      );
      return "submitted code changes";
    },
  ];

  const makeRunner = (runtime: ScriptedBuildRuntime) =>
    makeBuildStepRunner({ db, runtime, registry, source: origin, modelRef: "fake:scripted" });

  try {
    // --- 3. The implementation task (as the merge webhook would spawn it, §29.1). ---
    const tenant = await db.createTenant({ name: `demo-k4-${Date.now()}` });
    const orchestrator = new Orchestrator(db, queue);
    const { task } = await orchestrator.submit({
      tenantId: tenant.id,
      sourceType: "github",
      sourceRef: {
        kind: "implementation",
        repo: REPO,
        planRef: { repo: REPO, docPath: "docs/plan.md", approvedSha },
        baseSha: approvedSha,
      },
      inputText: "Implement the approved plan in docs/plan.md.",
      idempotencyKey: `${REPO}:docs/plan.md:${approvedSha}:implement:k4`,
    });

    // --- 4. Worker #1: crash mid-BUILD, right after turn 1's checkpoint lands. ---
    const visibilityMs = 1200;
    const w1 = new Worker(queue, db, {
      stepRunner: makeRunner(new ScriptedBuildRuntime({ turns, crashAfterTurn: 1 })),
      visibilityMs,
    });
    const o1 = await w1.runOnce();
    assert(o1 === "crashed", `worker #1 crashed mid-BUILD (got '${o1}')`);

    const afterCrash = await db.getTask(task.id);
    const cp = parseCheckpoint(afterCrash!.checkpoint);
    assert(cp.turnIndex === 1, `checkpoint is at turn 1 (got ${cp.turnIndex})`);
    assert(cp.phase === "build", "checkpoint phase is 'build'");
    assert(cp.baseSha === approvedSha, "checkpoint pins base_sha to the plan's merge commit");
    assert(
      (cp.workspaceDiff ?? "").includes("hi ${name}"),
      "checkpoint carries the workspace diff vs base_sha",
    );
    assert((await db.countTaskSteps(task.id)) === 2, "exactly 2 per-turn step rows persisted before the crash");
    assert(client.writes.length === 0, "no GitHub effects happened before the crash");

    // --- 5. Worker #2: reclaim after the visibility timeout and RESUME. ---
    await sleep(visibilityMs + 500);
    const w2 = new Worker(queue, db, {
      stepRunner: makeRunner(new ScriptedBuildRuntime({ turns })),
      visibilityMs: 10_000,
    });
    const outcomes = await w2.drain();
    assert(outcomes.includes("completed"), `worker #2 resumed to completion (got ${outcomes.join(",")})`);

    // --- 6. Exactly-once + one PR. ---
    assert(ran[0] === 1 && ran[1] === 1, "checkpointed turns were NOT re-run on resume");
    assert(ran[2] === 1, "the interrupted tail ran exactly once");

    const finalTask = await db.getTask(task.id);
    assert(finalTask!.status === "completed", `task completed (got ${finalTask!.status})`);
    const finalCp = parseCheckpoint(finalTask!.checkpoint);
    assert(
      finalCp.completedSteps.join(",") === "turn:0,turn:1,turn:2,build:final",
      `completed steps are exactly once each (got ${finalCp.completedSteps.join(",")})`,
    );

    const change = await store.getCodeChangeByTask(task.id);
    assert(change?.state === "submitted_ready", "green verification → ready PR recorded");
    const prs = [...client.openPrs.values()];
    assert(prs.length === 1, `exactly ONE PR exists after kill + resume (got ${prs.length})`);
    assert((await db.countModelInvocations(task.id)) === 3, "per-turn model usage recorded once per turn");

    console.log(`\ndemo-k4 OK: ${change?.prUrl} (${change?.state}) after mid-BUILD kill + resume`);
  } finally {
    await execFileAsync("rm", ["-rf", origin]);
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-k4 FAILED:", err);
  process.exit(1);
});
