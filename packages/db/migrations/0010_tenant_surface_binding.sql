-- §2b #14: one tenant across the live surfaces. A Slack team and a GitHub
-- owner are surface BINDINGS on a tenant record (kept in settings), not
-- tenant keys of their own — the live apps resolve an event's tenant by its
-- binding, and a configured deployment (MARATHON_TENANT) lets both apps
-- attach their bindings to the same tenant. Tenants are the isolation
-- boundary, so a surface id may belong to at most ONE tenant; enforce that
-- here. The `deployment` marker is likewise unique: it is the explicit
-- admin-level key the live apps rendezvous on (never name matching — demo
-- tenants reuse display names freely and must not capture live bindings).

create unique index if not exists tenant_slack_team_binding
  on tenant ((settings->>'slack_team_id'))
  where settings->>'slack_team_id' is not null;

create unique index if not exists tenant_github_owner_binding
  on tenant ((settings->>'github_owner'))
  where settings->>'github_owner' is not null;

create unique index if not exists tenant_deployment_binding
  on tenant ((settings->>'deployment'))
  where settings->>'deployment' is not null;
