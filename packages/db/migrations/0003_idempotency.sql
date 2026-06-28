-- M5: write-action idempotency (exactly-once execution of approved effects).
create table idempotency_key (
  key        text primary key,
  created_at timestamptz not null default now()
);
