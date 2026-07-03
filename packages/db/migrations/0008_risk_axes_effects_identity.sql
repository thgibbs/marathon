-- Track 3 (code-migration.md): align schema with the current data model.
--
-- 1. proposed_effect (design §10.17): high-risk effects are proposals executed
--    by a non-model executor, not direct tool calls. Deferred behind the kernel
--    (M10), but modeled now so the schema stops encoding destructive-approval.
-- 2. risk_axes replaces risk_level on tool_invocation and approval_request
--    (design §7.8: reversibility / trust-boundary / audience / cost).
-- 3. approval_request.proposed_effect_id (design §10.12).
-- 4. task status: retire 'blocked' (design §11.1 — retrying and the waiting
--    states cover its cases).
-- 5. user_identity: verification fields (design §10.2, §7.20).

create table proposed_effect (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  task_id             uuid not null references task(id) on delete cascade,
  connector_id        text,              -- loose until ConnectorInstallation is modeled
  effect_type         text not null,     -- slack_post | email_send | github_merge | ...
  target              jsonb not null default '{}',
  payload             jsonb not null,    -- the EXACT proposed content or mutation
  payload_hash        text not null,     -- approval binds to this; a changed payload voids it
  proposal_version    int not null default 1,
  provenance          jsonb,             -- what the agent read to produce this
  risk_axes           jsonb,
  rollback_plan       text,
  reviewer_id         uuid references app_user(id) on delete set null,
  reviewer_authority  text,
  approval_expires_at timestamptz,
  idempotency_key     text not null,     -- bounds execution to at most once
  execution_state     text not null default 'proposed'
                        check (execution_state in ('proposed','approved','rejected','expired',
                          'executing','executed','failed')),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  executed_at         timestamptz,
  unique (tenant_id, idempotency_key)
);
create index proposed_effect_task_idx on proposed_effect(task_id);
create index proposed_effect_tenant_idx on proposed_effect(tenant_id);

alter table tool_invocation add column risk_axes jsonb;
alter table tool_invocation drop column risk_level;

alter table approval_request add column risk_axes jsonb;
alter table approval_request drop column risk_level;
alter table approval_request
  add column proposed_effect_id uuid references proposed_effect(id) on delete set null;

-- Retire 'blocked': it was only ever a resumable pause, which the waiting
-- states now cover; any legacy rows resume via waiting_for_approval.
update task set status = 'waiting_for_approval' where status = 'blocked';
alter table task drop constraint task_status_check;
alter table task add constraint task_status_check
  check (status in ('created','queued','running','waiting_for_input',
    'waiting_for_approval','retrying','completed','failed','cancelled','expired'));

alter table user_identity add column verified_at timestamptz;
alter table user_identity add column verification_method text
  check (verification_method in ('oauth','idp','admin_asserted'));
alter table user_identity add column status text not null default 'active'
  check (status in ('active','stale','revoked'));
alter table user_identity add column credential_ref text;
