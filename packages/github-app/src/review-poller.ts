import { CODE_REVIEW_JOB_KIND } from "@marathon/worker";
import { backoffMs, type FailOutcome, type Job } from "@marathon/queue";
import { runCodeReviewJob, runDesignReviewJob, type GithubAppDeps } from "./handlers";

/**
 * The durable review consumer (§A.3a). A PR's producing surface enqueues a
 * review job after committing its artifact — a `DESIGN_REVIEW_JOB_KIND` job when
 * a doc PR's DocumentArtifact is written (#19), a `CODE_REVIEW_JOB_KIND` job when
 * `delivery.report_pr` records a green code delivery. This runs one such
 * (already-leased) job, dispatched by `job.kind`: heartbeat the lease for as long
 * as the review + kickback loop runs, then ack on success / fail-with-backoff on
 * error.
 *
 * The lease is HEARTBEAT-renewed because one run spans several model turns plus
 * the capped revision loop — well past a single visibility window. If a renewal
 * is ever rejected (another poller reclaimed an expired lease in a scaled
 * deployment), we ABANDON: our token is stale, the current owner will finish,
 * and we must not ack/fail under a token we no longer hold (which would either
 * no-op silently or corrupt another worker's job). The heartbeat is always
 * stopped before returning.
 */

/** The queue operations the poller needs — `Queue` satisfies this structurally. */
export interface ReviewJobQueue {
  heartbeat(jobId: string, leaseToken: string, visibilityMs: number): Promise<boolean>;
  ack(jobId: string, leaseToken: string): Promise<boolean>;
  fail(jobId: string, leaseToken: string, error: string, backoffMillis: number): Promise<FailOutcome>;
}

export type ReviewJobOutcome = "completed" | "retry" | "dead" | "lease-lost";

export interface ProcessReviewJobOptions {
  /** Lease/visibility window renewed on each heartbeat (default 300s). */
  visibilityMs?: number;
  /** Heartbeat interval — must be well under `visibilityMs` (default 60s). */
  heartbeatMs?: number;
  /**
   * Injectable lease monitor (default: a `setInterval` that renews via
   * `queue.heartbeat` and calls `onLost` when a renewal is rejected/throws).
   * Returns a `stop()` the processor calls when the run ends. Overridden in
   * tests to drive lease loss deterministically without timers.
   */
  monitorLease?: (onLost: () => void) => () => void;
}

/**
 * Process one already-leased review job to a terminal outcome, dispatched by
 * `job.kind` (a `CODE_REVIEW_JOB_KIND` job runs the code review; anything else —
 * the design-review job — runs the design review). Returns `"lease-lost"` if the
 * lease was reclaimed mid-run (the job is left for its new owner), `"completed"`
 * on a successful ack, or `"retry"`/`"dead"` from the backoff/dead-letter path on
 * a thrown error.
 */
export async function processReviewJob(
  queue: ReviewJobQueue,
  deps: GithubAppDeps,
  job: Pick<Job, "id" | "kind" | "leaseToken" | "taskId" | "attempts">,
  opts: ProcessReviewJobOptions = {},
): Promise<ReviewJobOutcome> {
  const token = job.leaseToken;
  if (!token) return "lease-lost";
  const visibilityMs = opts.visibilityMs ?? 300_000;
  const heartbeatMs = opts.heartbeatMs ?? 60_000;

  let leaseLost = false;
  const markLost = (): void => {
    leaseLost = true;
  };
  const monitor =
    opts.monitorLease ??
    ((onLost: () => void) => {
      const h = setInterval(() => {
        void queue
          .heartbeat(job.id, token, visibilityMs)
          .then((ok) => {
            if (!ok) onLost();
          })
          .catch(() => onLost());
      }, heartbeatMs);
      return () => clearInterval(h);
    });
  const stop = monitor(markLost);

  try {
    const runJob = job.kind === CODE_REVIEW_JOB_KIND ? runCodeReviewJob : runDesignReviewJob;
    await runJob(deps, job.taskId);
  } catch (e) {
    stop();
    // Reclaimed mid-run: leave the job for whoever holds the lease now.
    if (leaseLost) return "lease-lost";
    const outcome = await queue.fail(job.id, token, String(e), backoffMs(job.attempts));
    return outcome === "dead" ? "dead" : outcome === "lost" ? "lease-lost" : "retry";
  }
  stop();
  if (leaseLost) return "lease-lost";
  // A rejected ack means the lease was lost after the last heartbeat — surface
  // it (the caller logs) rather than silently treating the job as done.
  const acked = await queue.ack(job.id, token);
  return acked ? "completed" : "lease-lost";
}
