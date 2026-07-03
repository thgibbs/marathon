import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ScriptedBuildRuntime, ScriptedCrash } from "@marathon/agent";
import { CodeTaskRegistry } from "@marathon/code-handoff";
import { emptyCheckpoint, parseCheckpoint, type Checkpoint, type Task } from "@marathon/core";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDiffSnapshot, makeBuildStepRunner, resolveBuildBinding, type BuildStepDb } from "../src/build-step";

const execFileAsync = promisify(execFile);

let origin: string;
let baseSha: string;
const REPO = "acme/service";

beforeAll(async () => {
  origin = await mkdtemp(join(tmpdir(), "marathon-build-origin-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", origin, ...args]);
  await execFileAsync("git", ["init", "--quiet", origin]);
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@test");
  await writeFile(join(origin, "greet.mjs"), `export const greet = () => "hi";\n`);
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "plan merged");
  baseSha = (await git("rev-parse", "HEAD")).stdout.trim();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    agentId: null,
    agentVersionId: null,
    invokingUserId: null,
    sourceTaskId: "doc-task-1",
    sourceType: "github",
    sourceRef: {
      kind: "implementation",
      planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: baseSha },
      baseSha,
    },
    deliveryTargets: null,
    status: "running",
    inputText: "Implement the approved plan.",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** In-memory BuildStepDb: records completeStep calls like the real one would. */
function makeDb(task: Task) {
  const steps: Array<{ stepType: string; checkpoint: Checkpoint; invocations: number }> = [];
  const db: BuildStepDb = {
    getTask: async () => task,
    completeStep: async (_taskId, stepType, checkpoint, modelInvocations = []) => {
      steps.push({ stepType, checkpoint, invocations: modelInvocations.length });
      task.checkpoint = JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>;
    },
  };
  return { db, steps };
}

describe("makeBuildStepRunner (BUILD-stage workspace lifecycle + per-turn checkpoints)", () => {
  it("persists a diff-carrying checkpoint after every completed turn", async () => {
    const task = makeTask();
    const { db, steps } = makeDb(task);
    const registry = new CodeTaskRegistry();
    const runtime = new ScriptedBuildRuntime({
      turns: [
        async ({ workspace }) => {
          await writeFile(join(workspace!.dir, "greet.mjs"), `export const greet = (n) => "hi " + n;\n`);
          return "edited greet";
        },
        async ({ workspace }) => {
          await writeFile(join(workspace!.dir, "test.mjs"), `console.log("ok");\n`);
          return "added test";
        },
      ],
    });
    const run = makeBuildStepRunner({ db, runtime, registry, source: origin, modelRef: "fake:scripted" });

    const res = await run({ taskId: task.id, checkpoint: emptyCheckpoint() });
    expect(res.done).toBe(true);
    expect(res.stepType).toBe("build:final");

    expect(steps.map((s) => s.stepType)).toEqual(["turn:0", "turn:1"]);
    const cp0 = steps[0]!.checkpoint;
    expect(cp0.phase).toBe("build");
    expect(cp0.turnIndex).toBe(0);
    expect(cp0.baseSha).toBe(baseSha);
    expect(cp0.planRef?.docPath).toBe("docs/plan.md");
    expect(cp0.workspaceDiff).toContain('"hi " + n'); // the turn's edit, vs base_sha
    expect(steps[1]!.checkpoint.workspaceDiff).toContain("test.mjs");
    expect(steps[0]!.invocations).toBe(1); // per-turn model usage recorded

    // teardown: registry cleared, workspace dir destroyed
    expect(registry.get(task.id)).toBeUndefined();
    expect(res.checkpoint.completedSteps).toEqual(["turn:0", "turn:1", "build:final"]);
  });

  it("crash mid-run, then resume: fresh workspace + replayed diff, no repeated turns", async () => {
    const task = makeTask();
    const { db, steps } = makeDb(task);
    const registry = new CodeTaskRegistry();

    const crashing = new ScriptedBuildRuntime({
      turns: [
        async ({ workspace }) => {
          await writeFile(join(workspace!.dir, "greet.mjs"), `export const greet = (n) => "hi " + n;\n`);
          return "edited greet";
        },
        async () => "never runs before the crash",
      ],
      crashAfterTurn: 0,
    });
    const runCrash = makeBuildStepRunner({ db, runtime: crashing, registry, source: origin, modelRef: "fake:scripted" });
    await expect(runCrash({ taskId: task.id, checkpoint: emptyCheckpoint() })).rejects.toBeInstanceOf(ScriptedCrash);
    expect(steps).toHaveLength(1); // turn 0 checkpointed before the crash
    expect(registry.get(task.id)).toBeUndefined(); // torn down even on the way out

    // A fresh worker resumes from the persisted checkpoint: turn 0 is NOT
    // replayed, and its edit is already in the re-materialized workspace.
    const replayed: number[] = [];
    let seenGreet = "";
    const resumed = new ScriptedBuildRuntime({
      turns: [
        async ({ turnIndex }) => (replayed.push(turnIndex), "should not run"),
        async ({ workspace, turnIndex }) => {
          replayed.push(turnIndex);
          seenGreet = await readFile(join(workspace!.dir, "greet.mjs"), "utf8");
          return "finished";
        },
      ],
    });
    const runResume = makeBuildStepRunner({ db, runtime: resumed, registry, source: origin, modelRef: "fake:scripted" });
    const res = await runResume({ taskId: task.id, checkpoint: parseCheckpoint(task.checkpoint) });

    expect(replayed).toEqual([1]); // resume starts after the last completed turn
    expect(seenGreet).toContain('"hi " + n'); // turn 0's diff was replayed onto the fresh clone
    expect(res.done).toBe(true);
    // the resume prompt tells the agent its workspace was restored
    expect(res.checkpoint.turnIndex).toBe(1);
  });

  it("marks the resume in the agent's input", async () => {
    const task = makeTask();
    const { db } = makeDb(task);
    let input = "";
    const runtime = new ScriptedBuildRuntime({
      turns: [() => "already checkpointed", ({ request }) => ((input = request.input), "done")],
    });
    const run = makeBuildStepRunner({
      db,
      runtime,
      registry: new CodeTaskRegistry(),
      source: origin,
      modelRef: "fake:scripted",
    });
    await run({ taskId: task.id, checkpoint: { ...emptyCheckpoint(), turnIndex: 0, baseSha, planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: baseSha } } });
    expect(input).toContain("restored to your last checkpoint (turn 0)");
    expect(input).toContain("Implement the approved plan.");
  });

  it("spills over-cap diffs to diffDir and loads them back for replay", async () => {
    const task = makeTask();
    const { db, steps } = makeDb(task);
    const diffDir = await mkdtemp(join(tmpdir(), "marathon-diffs-"));
    const big = "x".repeat(4096);
    const runtime = new ScriptedBuildRuntime({
      turns: [
        async ({ workspace }) => {
          await writeFile(join(workspace!.dir, "big.txt"), big);
          return "wrote big file";
        },
      ],
    });
    const run = makeBuildStepRunner({
      db,
      runtime,
      registry: new CodeTaskRegistry(),
      source: origin,
      modelRef: "fake:scripted",
      inlineDiffCapBytes: 1024,
      diffDir,
    });
    await run({ taskId: task.id, checkpoint: emptyCheckpoint() });

    const cp = steps[0]!.checkpoint;
    expect(cp.workspaceDiff).toBeUndefined();
    expect(cp.workspaceDiffRef).toContain(diffDir);
    const loaded = await loadDiffSnapshot(parseCheckpoint(task.checkpoint));
    expect(loaded).toContain("big.txt");
  });

  it("resolveBuildBinding prefers the checkpoint, falls back to sourceRef, rejects neither", () => {
    const task = makeTask();
    const fromInput = resolveBuildBinding(task, emptyCheckpoint());
    expect(fromInput?.baseSha).toBe(baseSha);

    const cpBinding = resolveBuildBinding(task, {
      ...emptyCheckpoint(),
      baseSha: "other-sha",
      planRef: { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: "other-sha" },
    });
    expect(cpBinding?.baseSha).toBe("other-sha");

    expect(resolveBuildBinding(makeTask({ sourceRef: {} }), emptyCheckpoint())).toBeNull();
  });
});
