-- SPDX-License-Identifier: AGPL-3.0-only
-- pages seen per viewer session, not one event per page

create table view_session (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  node_id       uuid not null references node(id),
  version_id    uuid not null references document_version(id),
  person_id     uuid not null references person(id),
  opened_at     timestamptz not null,
  last_seen_at  timestamptz not null,
  page_count    integer not null check (page_count >= 0),
  pages_seen    integer[] not null default '{}'
);
create index view_session_node on view_session (node_id, version_id);
create index view_session_person on view_session (person_id, opened_at desc);
create index view_session_workspace on view_session (workspace_id, opened_at desc);

create index derived_file_version_kind on derived_file (version_id, kind);

do $$
declare t text;
begin
  foreach t in array array['view_session'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;
