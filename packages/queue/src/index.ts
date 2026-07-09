import { Pool } from "pg";

export * from "./backoff";

export type JobStatus = "ready" | "leased" | "done" | "dead";

/** The kind jobs are enqueued with when none is given. */
export const DEFAULT_JOB_KIND = "task";

export interface Job {
  id: string;
  taskId: string | null;
  kind: string;
  idempotencyKey: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leasedUntil: Date | null;
  leaseToken: string | null;
  lastError: string | null;
}

export interface EnqueueInput {
  taskId?: string;
  kind?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
  /**
   * When true, the job is inserted in the terminal 'done' state so no worker
   * can ever lease it. Use for inline-driven tasks whose caller executes the
   * work directly: the row still serves as an idempotency ledger entry (the
   * same key on a re-submit finds this row and returns deduped=true), but it
   * is never runnable work. Has no effect when idempotencyKey is absent —
   * without a key there is nothing to deduplicate, so the insert is skipped
   * entirely by the Orchestrator.
   */
  inline?: boolean;
}

export interface EnqueueResult {
  job: Job | null;
  /** true when an existing job with the same idempotency key already existed. */
  deduped: boolean;
}

export type FailOutcome = "retry" | "dead" | "lost";

/**
 * A durable, Postgres-backed job queue with leases and visibility timeouts.
 * A crashed worker's job is reclaimed once its lease expires. Kept simple and
 * workflow-engine-compatible (design.md §22.3).
 */
export class Queue {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Insert a job; a duplicate idempotency key is a no-op (returns deduped). */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    // Inline tasks insert as 'done' so the row acts as an idempotency ledger
    // entry only — no worker can ever lease a 'done' job (dequeue selects
    // 'ready' or expired-'leased' rows only). Without a key there is nothing
    // to deduplicate, so skip the insert entirely (the caller handles that).
    const status = input.inline ? "done" : "ready";
    const { rows } = await this.pool.query(
      `insert into job(task_id, kind, idempotency_key, max_attempts, status)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing
       returning *`,
      [input.taskId ?? null, input.kind ?? DEFAULT_JOB_KIND, input.idempotencyKey ?? null, input.maxAttempts ?? 5, status],
    );
    if (rows[0]) return { job: rowToJob(rows[0]), deduped: false };
    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      return { job: existing, deduped: true };
    }
    return { job: null, deduped: true };
  }

  async findByIdempotencyKey(key: string): Promise<Job | null> {
    const { rows } = await this.pool.query(`select * from job where idempotency_key = $1`, [key]);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async getJob(id: string): Promise<Job | null> {
    const { rows } = await this.pool.query(`select * from job where id = $1`, [id]);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  /**
   * Atomically lease the next available job: either a ready job whose time has
   * come, or a leased job whose visibility deadline has passed (crash recovery).
   * `kinds` partitions workers on a shared queue (Track 15): a filtered worker
   * only ever leases jobs of its own kinds, so it can never consume — or
   * dead-letter — work that belongs to another worker.
   */
  async dequeue(visibilityMs: number, opts: { kinds?: string[] } = {}): Promise<Job | null> {
    const { rows } = await this.pool.query(
      `update job set
         status = 'leased',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + ($1::int * interval '1 millisecond'),
         updated_at = now()
       where id = (
         select id from job
         where ((status = 'ready' and available_at <= now())
            or (status = 'leased' and leased_until < now()))
           and ($2::text[] is null or kind = any($2))
         order by available_at
         for update skip locked
         limit 1
       )
       returning *`,
      [visibilityMs, opts.kinds ?? null],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  /** Extend the lease. Returns false if the lease was lost (token mismatch). */
  async heartbeat(jobId: string, leaseToken: string, visibilityMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `update job set leased_until = now() + ($3::int * interval '1 millisecond'), updated_at = now()
       where id = $1 and lease_token = $2 and status = 'leased'`,
      [jobId, leaseToken, visibilityMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Mark a leased job done. */
  async ack(jobId: string, leaseToken: string): Promise<boolean> {
    const res = await this.pool.query(
      `update job set status = 'done', leased_until = null, updated_at = now()
       where id = $1 and lease_token = $2 and status = 'leased'`,
      [jobId, leaseToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Fail a leased job: retry with backoff, or dead-letter once attempts reach
   * max_attempts. Returns 'lost' if the lease no longer matches.
   */
  async fail(
    jobId: string,
    leaseToken: string,
    error: string,
    backoffMillis: number,
  ): Promise<FailOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `select attempts, max_attempts, lease_token, status from job where id = $1 for update`,
        [jobId],
      );
      const row = rows[0];
      if (!row || row.lease_token !== leaseToken || row.status !== "leased") {
        await client.query("rollback");
        return "lost";
      }
      if (row.attempts >= row.max_attempts) {
        await client.query(
          `update job set status = 'dead', last_error = $2, leased_until = null, updated_at = now()
           where id = $1`,
          [jobId, error],
        );
        await client.query("commit");
        return "dead";
      }
      await client.query(
        `update job set status = 'ready',
           available_at = now() + ($3::int * interval '1 millisecond'),
           lease_token = null, leased_until = null, last_error = $2, updated_at = now()
         where id = $1`,
        [jobId, error, backoffMillis],
      );
      await client.query("commit");
      return "retry";
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Force a leased job to the dead-letter state (for permanent failures). */
  async kill(jobId: string, leaseToken: string, error: string): Promise<boolean> {
    const res = await this.pool.query(
      `update job set status = 'dead', last_error = $3, leased_until = null, updated_at = now()
       where id = $1 and lease_token = $2 and status = 'leased'`,
      [jobId, leaseToken, error],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToJob(r: any): Job {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    availableAt: r.available_at,
    leasedUntil: r.leased_until,
    leaseToken: r.lease_token,
    lastError: r.last_error,
  };
}
