-- M1: durable task spine — job queue + task resume checkpoint.

alter table task add column checkpoint jsonb;

create table job (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references task(id) on delete cascade,
  kind            text not null default 'task',
  -- enqueue dedupe: NULLs are allowed and treated as distinct by Postgres.
  idempotency_key text unique,
  status          text not null default 'ready'
                    check (status in ('ready','leased','done','dead')),
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  -- when the job becomes leasable (used for retry backoff scheduling)
  available_at    timestamptz not null default now(),
  -- visibility deadline while leased; a worker crash is detected when this passes
  leased_until    timestamptz,
  lease_token     uuid,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index job_leasable_idx on job(status, available_at);
create index job_task_idx on job(task_id);
