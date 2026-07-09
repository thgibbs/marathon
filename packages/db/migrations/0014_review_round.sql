-- Per-PR automated-review state (codex-impl.md §A.3a). The reviewer's latest
-- verdict plus how many AUTOMATIC review rounds have run for this PR, so the
-- kickback loop can cap itself: a `changes_requested` bounces the PR back to its
-- owning agent to revise, but only up to a fixed number of automatic rounds —
-- then it stops and waits for a human. `kind` separates the design-doc review
-- from the code review on the same combined PR (§29.1a).
create table review_round (
  tenant_id    uuid not null references tenant(id) on delete cascade,
  repo         text not null,
  pr_number    integer not null,
  kind         text not null, -- 'design_review' | 'code_review'
  rounds       integer not null default 0,
  last_verdict text, -- 'approved' | 'changes_requested'
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, repo, pr_number, kind)
);
