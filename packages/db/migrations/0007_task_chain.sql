-- K2 (design §29.1, §0.3): the loop task chain. An implementation task records
-- the task it was spawned from (the design-doc task), so the chain
-- Slack ask -> doc task -> implementation task is first-class and inspectable.
alter table task add column source_task_id uuid references task(id) on delete set null;
create index task_source_task_idx on task(source_task_id);
