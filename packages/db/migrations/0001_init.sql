-- Marathon core schema (design.md §10). Tenant-scoped throughout.
-- Postgres 13+ provides gen_random_uuid() in core; no extension required.

create table tenant (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  settings              jsonb not null default '{}',
  retention_policy      jsonb,
  default_model_policy  jsonb,
  budget_policy         jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table app_user (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  display_name text,
  email        text,
  role         text not null default 'user'
                 check (role in ('admin','agent_owner','developer','user','viewer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index app_user_tenant_idx on app_user(tenant_id);

create table user_identity (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id) on delete cascade,
  surface_type text not null check (surface_type in ('slack','github','web','email')),
  external_id  text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (surface_type, external_id)
);

create table agent (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  display_name  text,
  description   text,
  owner_user_id uuid references app_user(id) on delete set null,
  status        text not null default 'draft'
                  check (status in ('draft','active','disabled','archived','deprecated')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, name)
);

create table agent_version (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references agent(id) on delete cascade,
  version_number int not null,
  status         text not null default 'draft'
                   check (status in ('draft','testing','published','rolled_back','deprecated')),
  instructions   text,
  model_policy   jsonb,
  tool_policy    jsonb,
  memory_policy  jsonb,
  approval_policy jsonb,
  created_by     uuid references app_user(id) on delete set null,
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  unique (agent_id, version_number)
);

create table task (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  agent_id         uuid references agent(id) on delete set null,
  agent_version_id uuid references agent_version(id) on delete set null,
  invoking_user_id uuid references app_user(id) on delete set null,
  source_type      text not null
                     check (source_type in ('slack','github','web','api','email','schedule')),
  source_ref       jsonb not null default '{}',
  delivery_targets jsonb,
  status           text not null default 'created'
                     check (status in ('created','queued','running','waiting_for_input',
                       'waiting_for_approval','blocked','retrying','completed','failed',
                       'cancelled','expired')),
  input_text       text,
  summary          text,
  cost_usd         numeric(12,6) not null default 0,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  failed_at        timestamptz,
  cancelled_at     timestamptz
);
create index task_tenant_idx on task(tenant_id);
create index task_status_idx on task(status);

create table task_step (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references task(id) on delete cascade,
  step_type    text not null,
  status       text not null default 'created',
  input_ref    text,
  output_ref   text,
  error        text,
  retry_count  int not null default 0,
  checkpoint   jsonb,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index task_step_task_idx on task_step(task_id);

create table model_invocation (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references task(id) on delete cascade,
  task_step_id   uuid references task_step(id) on delete set null,
  provider       text not null,
  model          text not null,
  prompt_version text,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(12,6),
  latency_ms     int,
  status         text,
  error          text,
  created_at     timestamptz not null default now()
);
create index model_invocation_task_idx on model_invocation(task_id);

create table tool_invocation (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references task(id) on delete cascade,
  task_step_id   uuid references task_step(id) on delete set null,
  tool_id        text not null,
  status         text,
  input_summary  text,
  output_summary text,
  risk_level     text check (risk_level in ('low','medium','high','critical')),
  approval_id    uuid,
  latency_ms     int,
  error          text,
  created_at     timestamptz not null default now()
);
create index tool_invocation_task_idx on tool_invocation(task_id);

create table approval_request (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenant(id) on delete cascade,
  task_id                uuid not null references task(id) on delete cascade,
  tool_invocation_id     uuid references tool_invocation(id) on delete set null,
  requested_by_agent_id  uuid references agent(id) on delete set null,
  requested_from_user_id uuid references app_user(id) on delete set null,
  status                 text not null default 'pending'
                           check (status in ('pending','approved','rejected','expired','cancelled')),
  action_summary         text,
  risk_level             text check (risk_level in ('low','medium','high','critical')),
  expires_at             timestamptz,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  resolved_by_user_id    uuid references app_user(id) on delete set null
);
create index approval_request_task_idx on approval_request(task_id);

create table feedback (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  task_id          uuid references task(id) on delete cascade,
  agent_id         uuid references agent(id) on delete set null,
  agent_version_id uuid references agent_version(id) on delete set null,
  user_id          uuid references app_user(id) on delete set null,
  feedback_type    text not null check (feedback_type in ('thumbs_up','thumbs_down','free_text')),
  rating           int,
  comment          text,
  created_at       timestamptz not null default now()
);
create index feedback_tenant_idx on feedback(tenant_id);

create table audit_event (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  actor_user_id  uuid references app_user(id) on delete set null,
  actor_agent_id uuid references agent(id) on delete set null,
  event_type     text not null,
  target_type    text,
  target_id      text,
  summary        text,
  metadata       jsonb,
  created_at     timestamptz not null default now()
);
create index audit_event_tenant_idx on audit_event(tenant_id);

create table document_artifact (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id) on delete cascade,
  surface_type       text not null default 'github',
  location           jsonb,
  title              text,
  role               text check (role in ('produced','watched')),
  owning_task_id     uuid references task(id) on delete set null,
  owning_agent_id    uuid references agent(id) on delete set null,
  last_revision_seen text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index document_artifact_tenant_idx on document_artifact(tenant_id);
