import {
  isTerminal,
  parseCheckpoint,
  type Checkpoint,
  type DeliveryTarget,
  type Id,
  type StepRunner,
  type SurfaceType,
  type Task,
} from "@marathon/core";
import { Database } from "@marathon/db";
import { backoffMs, classifyError, Queue } from "@marathon/queue";
import { jobKindForSourceRef } from "./build-step";

/** Thrown to simulate a hard crash mid-run: the lease is abandoned (no ack/nack). */
export class SimulatedCrash extends Error {
  constructor(public readonly afterStepIndex: number) {
    super(`simulated crash after step index ${afterStepIndex}`);
    this.name = "SimulatedCrash";
  }
}

export interface WorkerOptions {
  stepRunner: StepRunner;
  visibilityMs?: number;
  /**
   * Job kinds this worker leases (Track 15). Workers on a shared queue
   * partition BY KIND at dequeue time — a job is only ever leased by a worker
   * that owns its kind, so distinct workers (the BUILD worker, the general
   * agent worker) can never steal each other's work. Omit to lease every kind
   * (single-worker deployments, demo sweepers).
   */
  kinds?: string[];
  /** Test hook: abandon the lease right after persisting this step index. */
  crashAfterStepIndex?: number;
  /** Heartbeat cadence is implicit (once per step) for M1. */
  /**
   * Publishes the clarifying question to the task's surfaces (Track 12,
   * §11.6) — see `makeWaitingNotifier`. The worker calls this BEFORE parking
   * the task: a failed publish keeps the job alive (retry with backoff), and a
   * redelivered job re-publishes from the checkpointed `pendingQuestion`
   * without re-running the asking turn — the wait is never "published" until
   * someone actually heard the question.
   */
  onWaiting?: (taskId: Id, waiting: { kind: "input"; question: string }) => Promise<void> | void;
}

export type RunOutcome = "idle" | "completed" | "waiting" | "crashed" | "retry" | "dead";

/**
 * Leases one job at a time, advances its task step-by-step, checkpointing after
 * each step. A crash (or abandoned lease) is recovered by the next worker once
 * the visibility deadline passes — resuming from the checkpoint with no repeated
 * effects (exactly-once).
 */
export class Worker {
  private readonly visibilityMs: number;

  constructor(
    private readonly queue: Queue,
    private readonly db: Database,
    private readonly opts: WorkerOptions,
  ) {
    this.visibilityMs = opts.visibilityMs ?? 30_000;
  }

  async runOnce(): Promise<RunOutcome> {
    const job = await this.queue.dequeue(this.visibilityMs, { kinds: this.opts.kinds });
    if (!job || !job.leaseToken) return "idle";
    const token = job.leaseToken;

    if (!job.taskId) {
      await this.queue.ack(job.id, token);
      return "completed";
    }

    let task = await this.db.getTask(job.taskId);
    if (!task) {
      await this.queue.ack(job.id, token);
      return "completed";
    }
    if (isTerminal(task.status)) {
      await this.queue.ack(job.id, token);
      return "completed";
    }

    try {
      task = await this.ensureRunning(task);
      let checkpoint = parseCheckpoint(task.checkpoint);

      // Recovery gate (Track 12): a redelivered job whose checkpoint carries an
      // unanswered question re-publishes and re-parks — never runs more turns.
      const recovered = await this.tryPark(job.id, token, job.taskId, job.attempts, checkpoint);
      if (recovered) return recovered;

      // advance steps until done
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const stepIndex = checkpoint.completedSteps.length;
        const res = await this.opts.stepRunner({ taskId: job.taskId, checkpoint });
        if (res.done && res.stepType === "noop") break; // nothing left to do

        // persist effect + checkpoint (+ any model invocations) atomically — the
        // basis for exactly-once resume. The whole checkpoint is stored: the
        // BUILD-stage fields (§11.2) must survive to the DB or resume cannot
        // restore the session/workspace.
        await this.db.completeStep(
          job.taskId,
          res.stepType,
          res.checkpoint,
          res.modelInvocations ?? [],
        );
        checkpoint = res.checkpoint;
        await this.queue.heartbeat(job.id, token, this.visibilityMs);

        if (this.opts.crashAfterStepIndex === stepIndex) {
          throw new SimulatedCrash(stepIndex);
        }

        // Durable human wait (Track 12, §11.6): publish the question, THEN
        // park. The asking turn's checkpoint already landed, so a publish
        // failure retries this job into the recovery gate above — the wait is
        // not "real" until the question was heard.
        if (res.waiting) {
          // The in-memory copy always carries the question, even if a custom
          // runner forgot to stage it in the checkpoint.
          const withQuestion: Checkpoint =
            checkpoint.pendingQuestion !== undefined
              ? checkpoint
              : { ...checkpoint, pendingQuestion: res.waiting.question };
          const parked = await this.tryPark(job.id, token, job.taskId, job.attempts, withQuestion);
          if (parked) return parked;
        }
        if (res.done) break;
      }

      await this.db.transitionTask(job.taskId, "completed");
      await this.queue.ack(job.id, token);
      return "completed";
    } catch (err) {
      // Matched by name, not instanceof: runtimes (e.g. ScriptedBuildRuntime's
      // ScriptedCrash) simulate mid-run deaths without importing the worker.
      if (err instanceof Error && err.name === "SimulatedCrash") {
        // abandon the lease — exactly what a real crash does. Recovered on timeout.
        return "crashed";
      }
      if (classifyError(err) === "transient") {
        const outcome = await this.queue.fail(
          job.id,
          token,
          String(err),
          backoffMs(job.attempts, { baseMs: 200, maxMs: 5_000 }),
        );
        return outcome === "dead" ? "dead" : "retry";
      }
      // permanent failure: fail the task and dead-letter the job
      await this.safeFailTask(job.taskId, String(err));
      await this.queue.kill(job.id, token, String(err));
      return "dead";
    }
  }

  /** Lease + run jobs until the queue is idle (or a safety cap is hit). */
  async drain(maxIterations = 1000): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < maxIterations; i++) {
      const outcome = await this.runOnce();
      outcomes.push(outcome);
      if (outcome === "idle") break;
    }
    return outcomes;
  }

  private async ensureRunning(task: Task): Promise<Task> {
    let t = task;
    if (t.status === "created") t = await this.db.transitionTask(t.id, "queued");
    if (t.status === "queued") t = await this.db.transitionTask(t.id, "running");
    return t;
  }

  /**
   * Publish an unanswered staged question and park the task (Track 12, §11.6).
   * Returns null when the checkpoint carries no unanswered question. Ordering
   * is the durability contract:
   *   1. publish via onWaiting — a failure keeps the JOB alive (retry with
   *      backoff; never fails the task), and the redelivery re-enters here;
   *   2. transition to waiting_for_input (tolerating a prior attempt that
   *      crashed after transitioning);
   *   3. ack the job — resumeWithInput enqueues a fresh one with the answer.
   */
  private async tryPark(
    jobId: string,
    token: string,
    taskId: Id,
    attempts: number,
    checkpoint: Checkpoint,
  ): Promise<RunOutcome | null> {
    const question = checkpoint.pendingQuestion;
    if (question === undefined || checkpoint.pendingUserInput !== undefined) return null;

    try {
      await this.opts.onWaiting?.(taskId, { kind: "input", question });
    } catch (err) {
      // Publish failures retry regardless of classifyError: losing the
      // question would strand the task, and the task itself did nothing wrong.
      const outcome = await this.queue.fail(
        jobId,
        token,
        `question publish failed: ${String(err)}`,
        backoffMs(attempts, { baseMs: 200, maxMs: 5_000 }),
      );
      return outcome === "dead" ? "dead" : "retry";
    }
    const current = await this.db.getTask(taskId);
    if (current && current.status !== "waiting_for_input") {
      await this.db.transitionTask(taskId, "waiting_for_input");
    }
    await this.queue.ack(jobId, token);
    return "waiting";
  }

  private async safeFailTask(taskId: Id, _error: string): Promise<void> {
    try {
      await this.db.transitionTask(taskId, "failed");
    } catch {
      // best-effort; the task may not be in a failable state
    }
  }
}

/**
 * The Task Orchestrator entry point: turn an invocation into a durable task and
 * enqueue it. Idempotent on the queue's enqueue key.
 */
export class Orchestrator {
  constructor(
    private readonly db: Database,
    private readonly queue: Queue,
  ) {}

  async submit(input: {
    tenantId: Id;
    agentId?: Id;
    agentVersionId?: Id;
    invokingUserId?: Id;
    /** Chains this task to the one that spawned it (K2 task chain). */
    sourceTaskId?: Id;
    sourceType: SurfaceType;
    sourceRef?: Record<string, unknown>;
    /** Where progress/results land (design §10.8); defaults to [the source]. */
    deliveryTargets?: DeliveryTarget[];
    inputText?: string;
    idempotencyKey?: string;
  }): Promise<{ task: Task; deduped: boolean }> {
    // If this invocation was already submitted, reuse its task.
    if (input.idempotencyKey) {
      const existing = await this.queue.findByIdempotencyKey(input.idempotencyKey);
      if (existing?.taskId) {
        const task = await this.db.getTask(existing.taskId);
        if (task) return { task, deduped: true };
      }
    }

    const task = await this.db.createTask({
      tenantId: input.tenantId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      invokingUserId: input.invokingUserId,
      sourceTaskId: input.sourceTaskId,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      deliveryTargets: input.deliveryTargets,
      inputText: input.inputText,
    });
    const { deduped } = await this.queue.enqueue({
      taskId: task.id,
      // Partition by kind (Track 15): BUILD-stage tasks reach the BUILD worker.
      kind: jobKindForSourceRef(input.sourceRef),
      idempotencyKey: input.idempotencyKey,
    });
    await this.db.transitionTask(task.id, "queued");
    return { task, deduped };
  }
}
