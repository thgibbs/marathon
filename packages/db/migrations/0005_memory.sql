-- M7 memory store (design §7.12): scope × term memory with pgvector embeddings.
-- Requires the pgvector extension (provided by the pgvector/pgvector:pg16 image).

create extension if not exists vector;

create table memory_item (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  project_id  text,                                   -- a GitHub repo "owner/name" (for now)
  agent_id    uuid references agent(id) on delete cascade,
  thread_id   text,                                   -- conversation: Slack thread ts / "repo#n"
  level       text not null check (level in ('tenant','project','agent','thread')),
  term        text not null check (term in ('short','long')),
  kind        text not null,                          -- summary | correction | preference | ...
  text        text not null,
  metadata    jsonb not null default '{}',
  source      jsonb not null default '{}',
  embedding   vector(1536),                           -- OpenAI text-embedding-3-small
  created_at  timestamptz not null default now(),
  expires_at  timestamptz                             -- short-term TTL
);

create index memory_item_tenant_idx on memory_item(tenant_id);
create index memory_item_scope_idx on memory_item(tenant_id, level, project_id, agent_id, thread_id);
-- A vector ANN index (HNSW/IVFFlat) is a perf follow-on; small data uses exact scan.
