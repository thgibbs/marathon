import type { FailOutcome } from "@marathon/queue";
import { describe, expect, it } from "vitest";
import { processDesignReviewJob, type GithubAppDeps, type ReviewJobQueue } from "../src";

/**
 * §A.3a #19: the durable design-review consumer heartbeats its lease across the
 * multi-turn review + kickback loop, acks on success, retries with backoff on a
 * thrown error, and — critically — ABANDONS (never acks/fails under a stale
 * token) when the lease is reclaimed mid-run in a scaled deployment.
 */

const JOB = { id: "job-1", leaseToken: "tok-1", taskId: "doc-task", attempts: 1 };

// A fake queue that records ack/fail and lets the test script heartbeat replies.
function makeQueue(over: Partial<ReviewJobQueue> = {}) {
  const calls = { ack: 0, fail: 0, heartbeat: 0 };
  const queue: ReviewJobQueue = {
    heartbeat: async () => {
      calls.heartbeat++;
      return true;
    },
    ack: async () => {
      calls.ack++;
      return true;
    },
    fail: async () => {
      calls.fail++;
      return "retry" as FailOutcome;
    },
    ...over,
  };
  return { queue, calls };
}

// A deps whose review is a no-op (findDocumentArtifactByTask → null): the poller
// logic under test is the ack/fail/lease handling, not the review itself.
const NOOP_DEPS = { tenantId: "tn1", db: { findDocumentArtifactByTask: async () => null } } as never as GithubAppDeps;

// Never signals lease loss (the healthy case).
const heldLease = () => () => {};

describe("processDesignReviewJob (§A.3a #19)", () => {
  it("acks after a successful run (lease held)", async () => {
    const { queue, calls } = makeQueue();
    const outcome = await processDesignReviewJob(queue, NOOP_DEPS, JOB, { monitorLease: heldLease });
    expect(outcome).toBe("completed");
    expect(calls.ack).toBe(1);
    expect(calls.fail).toBe(0);
  });

  it("returns lease-lost and does NOT ack when the lease is reclaimed mid-run", async () => {
    const { queue, calls } = makeQueue();
    // Simulate a heartbeat rejection during the run.
    const outcome = await processDesignReviewJob(queue, NOOP_DEPS, JOB, {
      monitorLease: (onLost) => {
        onLost();
        return () => {};
      },
    });
    expect(outcome).toBe("lease-lost");
    expect(calls.ack).toBe(0); // must not ack under a stale token
    expect(calls.fail).toBe(0);
  });

  it("returns lease-lost when the final ack is rejected (lease lost after last heartbeat)", async () => {
    const { queue, calls } = makeQueue({ ack: async () => false });
    const outcome = await processDesignReviewJob(queue, NOOP_DEPS, JOB, { monitorLease: heldLease });
    expect(outcome).toBe("lease-lost");
    expect(calls.fail).toBe(0);
  });

  it("fails with backoff (retry) when the review throws", async () => {
    const deps = {
      tenantId: "tn1",
      db: {
        findDocumentArtifactByTask: async () => {
          throw new Error("github 500");
        },
      },
    } as never as GithubAppDeps;
    const { queue, calls } = makeQueue();
    const outcome = await processDesignReviewJob(queue, deps, JOB, { monitorLease: heldLease });
    expect(outcome).toBe("retry");
    expect(calls.fail).toBe(1);
    expect(calls.ack).toBe(0);
  });

  it("dead-letters when fail reports the job exhausted its attempts", async () => {
    const deps = {
      tenantId: "tn1",
      db: {
        findDocumentArtifactByTask: async () => {
          throw new Error("boom");
        },
      },
    } as never as GithubAppDeps;
    const { queue } = makeQueue({ fail: async () => "dead" as FailOutcome });
    const outcome = await processDesignReviewJob(queue, deps, JOB, { monitorLease: heldLease });
    expect(outcome).toBe("dead");
  });

  it("does not ack/fail a job with no lease token", async () => {
    const { queue, calls } = makeQueue();
    const outcome = await processDesignReviewJob(queue, NOOP_DEPS, { ...JOB, leaseToken: null }, { monitorLease: heldLease });
    expect(outcome).toBe("lease-lost");
    expect(calls.ack).toBe(0);
    expect(calls.fail).toBe(0);
  });
});
