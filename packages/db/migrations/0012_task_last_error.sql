-- Persist why a task failed (design/30-task-failure-reporting.md §30.2) so
-- `runAndReport` can tell the user the real reason instead of falling back to
-- the checkpoint (which never got a finding if the failure happened before a
-- turn produced one) — the source of the literal "(no response)" bug.
alter table task add column last_error text;
