-- K1 (design §10.19, §29.8): the first-class record of one BUILD → DELIVER handoff.
-- One row per implementation task; revisions (§29.6) update it.
create table code_change (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  task_id      uuid not null references task(id) on delete cascade,
  repo         text not null,
  plan_ref     jsonb not null,           -- { repo, doc_path, merge_commit_sha }
  base_sha     text not null,
  branch       text not null,            -- marathon/<task_id>-<slug>
  tree_hash    text,                     -- idempotency anchor for submit (§29.4)
  pr_number    int,
  pr_url       text,
  state        text not null default 'building'
                 check (state in ('building','submitted_draft','submitted_ready','merged','closed')),
  verification jsonb not null default '[]',  -- [{ command, exit_code, summary }]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (task_id)
);
create index code_change_tenant_idx on code_change(tenant_id);
