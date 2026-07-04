-- Track 13 memory migration (design §7.12, OQ-3 resolution): memory scopes are
-- audiences — tenant | project | user | thread. `agent` is retired as an access
-- scope; agent_id stays as relevance metadata only (boosts ranking, never gates
-- access). `source` becomes `provenance` ({ taskId, sensitivity, confirmedBy, ... }).

-- The new user scope: the requesting user's own context, preferences, and
-- corrections (self-affecting, so writes are ungated).
alter table memory_item add column user_id uuid references app_user(id) on delete cascade;

-- Existing agent-level rows predate audience gating and have no audience to
-- migrate to: they were recallable for every task of that agent, tenant-wide —
-- the injection/exfiltration channel OQ-3 flagged. Broadening them to tenant
-- scope would bypass the new confirmation gate, so they are dropped.
delete from memory_item where level = 'agent';

alter table memory_item drop constraint memory_item_level_check;
alter table memory_item add constraint memory_item_level_check
  check (level in ('tenant','project','user','thread'));

alter table memory_item rename column source to provenance;

drop index memory_item_scope_idx;
create index memory_item_scope_idx on memory_item(tenant_id, level, project_id, user_id, thread_id);
