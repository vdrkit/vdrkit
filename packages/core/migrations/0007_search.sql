-- SPDX-License-Identifier: AGPL-3.0-only
-- 'simple': no stemming, names and numbers stay intact. Access is filtered at query time.

create table document_text (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  node_id       uuid not null references node(id),
  version_id    uuid not null references document_version(id),
  page          integer not null check (page >= 1),
  body          text not null,
  tsv           tsvector generated always as (to_tsvector('simple', body)) stored,
  created_at    timestamptz not null default now(),
  unique (version_id, page)
);
create index document_text_tsv on document_text using gin (tsv);
create index document_text_node on document_text (node_id);

create index node_name_tsv on node using gin (to_tsvector('simple', name));

do $$
declare t text;
begin
  foreach t in array array['document_text'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;

grant delete on document_text to vdrkit_app;
