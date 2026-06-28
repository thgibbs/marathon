-- Fix: a surface identity is unique *within a tenant*, not globally (the same
-- Slack user id can appear in different tenants/workspaces).

alter table user_identity add column tenant_id uuid references tenant(id) on delete cascade;

update user_identity i set tenant_id = u.tenant_id
  from app_user u where u.id = i.user_id;

alter table user_identity alter column tenant_id set not null;

alter table user_identity drop constraint user_identity_surface_type_external_id_key;
alter table user_identity
  add constraint user_identity_tenant_surface_external_key
  unique (tenant_id, surface_type, external_id);

create index user_identity_tenant_idx on user_identity(tenant_id);
