-- SPDX-License-Identifier: AGPL-3.0-only
-- Destroying a key makes the workspace files unreadable, backups included

create table workspace_key (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  version       integer not null,
  provider      text not null,
  provider_key_version integer not null,
  wrapped       text,
  created_at    timestamptz not null default now(),
  destroyed_at  timestamptz,
  unique (workspace_id, version),
  check ((wrapped is null) = (destroyed_at is not null))
);

alter table document_version add column key_version integer;
alter table derived_file add column key_version integer;

alter table workspace_key enable row level security;
alter table workspace_key force row level security;
create policy tenant_isolation on workspace_key
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on workspace_key to vdrkit_app;
