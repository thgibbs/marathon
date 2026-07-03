import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRequest,
  AgentRuntime,
  AgentTurnCheckpoint,
  ModelInvocationData,
} from "@marathon/agent";
import { CodeWorkspace, type CodeTaskRegistry } from "@marathon/code-handoff";
import type { Checkpoint, PlanRef, StepContext, StepResult, Task } from "@marathon/core";
import { redactSecrets } from "@marathon/core";

/** What the BUILD runner needs from the database (Database satisfies this). */
export interface BuildStepDb {
  getTask(taskId: string): Promise<Task | null>;
  completeStep(
    taskId: string,
    stepType: string,
    checkpoint: Checkpoint,
    modelInvocations?: Array<Omit<ModelInvocationData, "taskId">>,
  ): Promise<void>;
}

export interface BuildStepOptions {
  db: BuildStepDb;
  runtime: AgentRuntime;
  /**
   * Handoff-tool binding (§29.4): the gateway reads the diff from the workspace
   * registered here. The runner registers on provision and removes on teardown.
   */
  registry: CodeTaskRegistry;
  /**
   * Host-side clone source for the task's repo — a local path or a
   * (possibly credentialed) URL. Never reaches the sandbox (§29.2).
   */
  source: string | ((task: Task) => string | Promise<string>);
  modelRef: string;
  instructions?: string;
  /** PR base for the handoff; defaults to "main". */
  defaultBranch?: string;
  /** Redact secrets from stored findings/trace (on by default). */
  redactTrace?: boolean;
  /**
   * Diff snapshots at or under this size are stored inline in the checkpoint
   * (`workspaceDiff`); larger ones go to `diffDir` as `workspaceDiffRef`.
   */
  inlineDiffCapBytes?: number;
  /** Where over-cap diff snapshots are written. Must survive a worker crash. */
  diffDir?: string;
}

const DEFAULT_INLINE_DIFF_CAP = 256 * 1024;
/** Durable terminal marker in `completedSteps`: the BUILD finished (§11.2). */
const FINAL_STEP = "build:final";
/** Keep the findings list bounded: the newest entries win. */
const MAX_FINDINGS = 200;

const DEFAULT_BUILD_INSTRUCTIONS =
  "You are Marathon's implementation agent. Work in /workspace (the repo, checked out at the " +
  "plan's merge commit). Read the merged plan and implement it. Use normal git locally " +
  "(status/diff/add/commit, branching); the sandbox has internet access for package installs " +
  "and documentation, but holds no credentials — GitHub writes go through the brokered tools: " +
  "git.exec to push your branch, github.exec (gh pr create / gh pr edit) to open or update the " +
  "PR. Verify with the repo's tests, then finish by calling delivery.report_pr exactly once " +
  "with the PR URL and honest verification results.";

/**
 * The BUILD-stage step runner (design §29.2, §11.2 BUILD-stage checkpoints;
 * roadmap K4). One worker step = one full agent run segment, but every
 * completed harness turn inside it persists a durable checkpoint carrying the
 * session ref and the workspace diff vs `base_sha`, so a crash mid-run resumes
 * at the last completed turn:
 *
 *  - provision: fresh clone at `base_sha`, checkpointed diff replayed
 *    (containers/workspaces are never recovered — §11.2);
 *  - the runtime works the workspace (sandboxed tools) and reports turn
 *    checkpoints; each is enriched with `git diff base_sha..worktree` and
 *    persisted atomically via `completeStep`;
 *  - teardown always destroys the workspace; the durable outputs are the
 *    pushed branch, the PR, and the task records.
 */
export function makeBuildStepRunner(opts: BuildStepOptions) {
  return async ({ taskId, checkpoint }: StepContext): Promise<StepResult> => {
    // The BUILD already finished (the durable `build:final` marker landed) but
    // the worker died before completing the task: converge without re-opening
    // the session or re-prompting a finished run.
    if (checkpoint.completedSteps.includes(FINAL_STEP)) {
      return { stepType: "noop", checkpoint, done: true };
    }

    const task = await opts.db.getTask(taskId);
    if (!task) throw new Error(`build step: task ${taskId} not found`);

    const binding = resolveBuildBinding(task, checkpoint);
    if (!binding) {
      throw new Error(
        `build step: task ${taskId} has no plan_ref/base_sha (not an implementation task?)`,
      );
    }
    const { planRef, baseSha } = binding;

    const source = typeof opts.source === "function" ? await opts.source(task) : opts.source;
    const redact = (s: string) => redactSecrets(s, { enabled: opts.redactTrace !== false });

    // Provision (§29.2): always a fresh materialization; a resume replays the
    // checkpointed diff on top of the pinned base.
    const workspace = await CodeWorkspace.materialize({ source, baseSha });
    try {
      const priorDiff = await loadDiffSnapshot(checkpoint);
      if (priorDiff) await workspace.applyDiff(priorDiff);
      opts.registry.set(taskId, {
        workspace,
        planRef,
        repo: planRef.repo,
        baseSha,
        defaultBranch: opts.defaultBranch,
      });

      const resuming = checkpoint.turnIndex !== undefined;
      const request: AgentRequest = {
        taskId,
        instructions: opts.instructions ?? DEFAULT_BUILD_INSTRUCTIONS,
        input: resuming
          ? `The worker restarted; your sandbox was re-provisioned and the workspace restored to ` +
            `your last checkpoint (turn ${checkpoint.turnIndex}). Re-verify anything that was in ` +
            `flight and continue the task.\n\nOriginal task: ${task.inputText ?? ""}`
          : task.inputText ?? "",
        modelRef: opts.modelRef,
        tenantId: task.tenantId,
        agentId: task.agentId ?? undefined,
      };

      // Timeline events ride in the checkpoint findings, size-capped so shell/test
      // output never floods storage or later prompts.
      let findings = [...checkpoint.findings];
      let completedSteps = [...checkpoint.completedSteps];
      let lastCheckpoint: Checkpoint = checkpoint;

      const onTurnCheckpoint = async (turn: AgentTurnCheckpoint): Promise<void> => {
        const diff = await workspace.captureDiff();
        const snapshot = await storeDiffSnapshot(opts, taskId, turn.turnIndex, diff);
        completedSteps = [...completedSteps, `turn:${turn.turnIndex}`];
        const cp: Checkpoint = {
          ...lastCheckpoint,
          completedSteps,
          findings,
          phase: "build",
          turnIndex: turn.turnIndex,
          baseSha,
          planRef,
          ...snapshot,
        };
        if (turn.sessionRef) cp.sessionRef = turn.sessionRef;
        // Atomic step + checkpoint persist (the K4 resume point).
        await opts.db.completeStep(
          taskId,
          `turn:${turn.turnIndex}`,
          cp,
          turn.modelInvocation ? [turn.modelInvocation] : [],
        );
        lastCheckpoint = cp;
      };

      const turn = await opts.runtime.nextTurn({
        request,
        checkpoint,
        workspace: { dir: workspace.dir, baseSha },
        onTurnCheckpoint,
        onEvent: (ev) => {
          const line = redact(`${ev.type}${ev.toolName ? `:${ev.toolName}` : ""} ${ev.summary}`);
          findings = [...findings, line].slice(-MAX_FINDINGS);
        },
      });

      const text = redact(turn.text ?? "");
      const finalCp: Checkpoint = {
        ...lastCheckpoint,
        completedSteps: [...completedSteps, ...(turn.done ? [FINAL_STEP] : [])],
        findings: [...findings, text].slice(-MAX_FINDINGS),
        phase: turn.done ? "delivering" : "build",
      };
      if (turn.sessionRef) finalCp.sessionRef = turn.sessionRef;
      if (turn.turnIndex !== undefined) finalCp.turnIndex = turn.turnIndex;

      if (!turn.done) {
        // Mid-run boundary (e.g. a future durable wait): the worker persists it.
        return {
          stepType: "build:segment",
          checkpoint: finalCp,
          done: false,
          modelInvocations: turn.modelInvocation ? [turn.modelInvocation] : [],
        };
      }

      // Persist the terminal marker DURABLY before reporting done: a crash after
      // this lands resumes as a no-op (see the top of this function) instead of
      // re-prompting a finished session. `stepType: "noop"` tells the worker not
      // to persist a duplicate step.
      await opts.db.completeStep(
        taskId,
        FINAL_STEP,
        finalCp,
        turn.modelInvocation ? [turn.modelInvocation] : [],
      );
      return { stepType: "noop", checkpoint: finalCp, done: true };
    } finally {
      // Teardown always (§29.2). A hard crash skips this — the resume path
      // re-materializes from the checkpoint, never from leftovers.
      opts.registry.delete(taskId);
      await workspace.dispose().catch(() => {});
    }
  };
}

/** The BUILD binding for a task: plan ref + pinned base, from input or checkpoint. */
export function resolveBuildBinding(
  task: Task,
  checkpoint: Checkpoint,
): { planRef: PlanRef; baseSha: string } | null {
  if (checkpoint.planRef && checkpoint.baseSha) {
    return { planRef: checkpoint.planRef, baseSha: checkpoint.baseSha };
  }
  const ref = task.sourceRef as {
    kind?: unknown;
    planRef?: { repo?: unknown; docPath?: unknown; mergeCommitSha?: unknown };
    baseSha?: unknown;
  };
  const p = ref?.planRef;
  if (
    typeof p?.repo === "string" &&
    typeof p.docPath === "string" &&
    typeof p.mergeCommitSha === "string" &&
    typeof ref.baseSha === "string"
  ) {
    return {
      planRef: { repo: p.repo, docPath: p.docPath, mergeCommitSha: p.mergeCommitSha },
      baseSha: ref.baseSha,
    };
  }
  return null;
}

/** Load the checkpointed workspace diff — inline or via its snapshot file. */
export async function loadDiffSnapshot(checkpoint: Checkpoint): Promise<string | null> {
  if (checkpoint.workspaceDiff !== undefined) return checkpoint.workspaceDiff;
  if (checkpoint.workspaceDiffRef) return readFile(checkpoint.workspaceDiffRef, "utf8");
  return null;
}

async function storeDiffSnapshot(
  opts: BuildStepOptions,
  taskId: string,
  turnIndex: number,
  diff: string,
): Promise<Pick<Checkpoint, "workspaceDiff" | "workspaceDiffRef">> {
  const cap = opts.inlineDiffCapBytes ?? DEFAULT_INLINE_DIFF_CAP;
  if (Buffer.byteLength(diff, "utf8") <= cap) {
    return { workspaceDiff: diff, workspaceDiffRef: undefined };
  }
  const dir = opts.diffDir ?? join(tmpdir(), "marathon-diffs");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${taskId}-turn-${turnIndex}.patch`);
  await writeFile(file, diff, "utf8");
  return { workspaceDiff: undefined, workspaceDiffRef: file };
}
