-- SPDX-License-Identifier: AGPL-3.0-only

create table upload_session (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id),
  workspace_id         uuid not null references workspace(id),
  person_id            uuid not null references person(id),
  -- becomes uploaded_by, read by the four-eyes rule
  principal_id         uuid not null references principal(id),
  -- both null: room top level (admins only)
  target_folder_id     uuid references node(id),
  replaces_node_id     uuid references node(id),
  relative_path        text not null check (length(relative_path) between 1 and 1024),
  numbering            text not null default 'from_names' check (numbering in ('from_names', 'alphabetical')),
  declared_size        bigint not null check (declared_size >= 0),
  declared_sha256      text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  mime                 text not null,
  quarantine_key       text not null,
  multipart_upload_id  text,
  part_size            bigint,
  part_count           integer,
  status               text not null default 'open' check (status in ('open', 'completed', 'rejected', 'aborted')),
  rejection            text,
  node_id              uuid references node(id),
  version_id           uuid references document_version(id),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  completed_at         timestamptz,
  check (target_folder_id is null or replaces_node_id is null)
);
create index upload_session_person on upload_session (person_id, created_at desc);
create index upload_session_open on upload_session (expires_at) where status = 'open';

-- seller groups in visible_to_group_ids meanwhile; release clears both
alter table document_version add column awaiting_release boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['upload_session'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;
