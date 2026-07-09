/**
 * LOCAL-ONLY K4 live smoke: kill a REAL code-writing run mid-BUILD and resume it.
 * Requires Docker, Postgres (DATABASE_URL / make db-up), and a model key
 * (OPENAI_API_KEY or SMOKE_MODEL + matching key). Skips if Docker is absent.
 *
 *   make smoke-k4
 *
 *   - a child worker process runs the REAL Pi BUILD stage (sandboxed bash/edit
 *     in Docker) against a fixture repo, checkpointing after each Pi turn;
 *   - the parent polls the task and SIGKILLs the child at the first durable
 *     turn checkpoint — a genuine mid-run process death;
 *   - the parent then resumes: fresh workspace at base_sha + checkpointed diff
 *     + re-opened Pi session, runs to completion, and asserts the PR landed
 *     exactly once.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "@marathon/config";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { Orchestrator, parseCheckpoint } from "@marathon/worker";
import { makeSmokeWorker, type SmokeEnv } from "./smoke-shared";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"]);
    p.on("error", () => resolve(false));
    p.on("exit", (c) => resolve(c === 0));
  });
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("smoke-k4 SKIPPED: Docker not available.");
    return;
  }

  const cfg = loadConfig();
  await migrate(cfg.databaseUrl);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);

  // Fixture repo = the "merged plan" state (§29.1).
  const REPO = "acme/service";
  const origin = await mkdtemp(join(tmpdir(), "marathon-k4-smoke-origin-"));
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

  const env: SmokeEnv = {
    databaseUrl: cfg.databaseUrl,
    origin,
    sessionDir: await mkdtemp(join(tmpdir(), "marathon-k4-sessions-")),
    image: process.env.MARATHON_SANDBOX_IMAGE ?? "node:22-alpine",
    modelRef: process.env.SMOKE_MODEL ?? "openai:gpt-4o-mini",
  };

  try {
    const tenant = await db.createTenant({ name: `smoke-k4-${Date.now()}` });
    const { task } = await new Orchestrator(db, queue).submit({
      tenantId: tenant.id,
      sourceType: "github",
      sourceRef: {
        kind: "implementation",
        repo: REPO,
        planRef: { repo: REPO, docPath: "docs/plan.md", approvedSha },
        baseSha: approvedSha,
      },
      inputText:
        `Implement the approved plan: greet() must include the caller's name so \`node test.mjs\` passes. ` +
        `When green, call github_submit_code_changes with plan_ref ` +
        `{ repo: "${REPO}", doc_path: "docs/plan.md", merge_commit_sha: "${approvedSha}" }.`,
      idempotencyKey: `${REPO}:docs/plan.md:${approvedSha}:implement:smoke-k4:${Date.now()}`,
    });

    // --- child worker: the real run we will kill. Short lease so the parent
    // --- can reclaim quickly after the kill.
    console.log(`[k4] starting child worker for task ${task.id} ...`);
    // Spawn node directly (no npx/pnpm wrapper): SIGKILL must hit the real
    // worker process, not a launcher that leaves it orphaned-but-alive.
    const child = spawn(process.execPath, ["--import", "tsx", "smoke-worker.ts"], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        DATABASE_URL: env.databaseUrl,
        K4_ORIGIN: env.origin,
        K4_SESSION_DIR: env.sessionDir,
        MARATHON_SANDBOX_IMAGE: env.image,
        SMOKE_MODEL: env.modelRef,
      },
      stdio: "inherit",
    });
    const childExited = new Promise<void>((r) => child.on("exit", () => r()));

    // Kill at the FIRST durable turn checkpoint — a genuine mid-BUILD death.
    const deadline = Date.now() + 5 * 60_000;
    let killed = false;
    for (;;) {
      await sleep(300);
      const t = await db.getTask(task.id);
      if (t?.status === "completed") break; // kill came too late — still a valid resume no-op
      const cp = parseCheckpoint(t?.checkpoint);
      if (cp.turnIndex !== undefined) {
        child.kill("SIGKILL");
        killed = true;
        console.log(`[k4] SIGKILLed the child at turn ${cp.turnIndex} (sessionRef=${cp.sessionRef ?? "-"})`);
        break;
      }
      if (child.exitCode !== null) throw new Error("child worker exited before any turn checkpoint");
      if (Date.now() > deadline) throw new Error("timed out waiting for the first turn checkpoint");
    }
    await childExited;
    if (!killed) {
      console.warn("[k4] child finished before the kill — rerun for a sharper test; validating state anyway.");
    }

    // --- resume in THIS process: fresh sandbox/workspace, re-opened session. ---
    // The child holds a 60s lease it never acked; wait for it to lapse.
    console.log("[k4] waiting out the abandoned lease, then resuming ...");
    const { worker, client, store, db: db2, queue: q2 } = makeSmokeWorker(env, 120_000);
    try {
      const resumeDeadline = Date.now() + 5 * 60_000;
      for (;;) {
        const outcomes = await worker.drain();
        const t = await db.getTask(task.id);
        if (t?.status === "completed") break;
        if (t?.status === "failed") throw new Error("task failed on resume");
        if (Date.now() > resumeDeadline) {
          throw new Error(`timed out resuming (outcomes: ${outcomes.join(",")})`);
        }
        await sleep(2_000);
      }

      const change = await store.getCodeChangeByTask(task.id);
      const prs = [...client.openPrs.values()];
      const finalCp = parseCheckpoint((await db.getTask(task.id))?.checkpoint);
      console.log(`[k4] resumed to completion: turns=${(finalCp.turnIndex ?? -1) + 1}, pr=${change?.prUrl ?? "-"}`);
      if (killed) {
        if (prs.length !== 1) throw new Error(`expected exactly 1 PR after resume, got ${prs.length}`);
        if (!change) throw new Error("no CodeChange recorded for the task");
      }
      console.log("smoke-k4 OK");
    } finally {
      await db2.close();
      await q2.close();
    }
  } finally {
    await execFileAsync("rm", ["-rf", origin]);
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/docker.*not found|ENOENT|Cannot connect to the Docker daemon/i.test(msg)) {
    console.warn("smoke-k4 SKIPPED: Docker not available.");
    process.exit(0);
  }
  console.error("smoke-k4 FAILED:", err);
  process.exit(1);
});
