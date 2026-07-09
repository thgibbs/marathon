-- Positive allow-list of Marathon-authored Slack messages (design/31-ack-via-reaction.md
-- §31.7 review follow-up): recording every postProgress/deliverResult message's `ts` lets
-- the reaction handler confirm a :+1: landed on OUR output, not merely "not the trigger" —
-- a reaction on an unrelated message or a task input that hasn't been persisted yet must
-- never be misread as feedback.
create table slack_output_message (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  channel    text not null,
  ts         text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, ts)
);
create index slack_output_message_tenant_idx on slack_output_message(tenant_id);
