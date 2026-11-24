-- SPDX-License-Identifier: AGPL-3.0-only
-- old index numbers and the "Renumbered" tag

alter table workspace add column renumbered_tag_days smallint not null default 3
  check (renumbered_tag_days between 0 and 365);
comment on column workspace.renumbered_tag_days is
  'Days that people see "Renumbered" beside a renumbered folder or document, counted per person from their first visit after the change.';

create table index_renumber (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references tenant(id),
  workspace_id   uuid not null references workspace(id),
  node_id        uuid not null,          -- no FK, outlives the node
  from_number    text not null,
  to_number      text,
  renumbered_at  timestamptz not null
);
create index index_renumber_from on index_renumber (workspace_id, from_number);
create index index_renumber_node on index_renumber (node_id, renumbered_at);
create index index_renumber_recent on index_renumber (workspace_id, renumbered_at);

create function index_renumber_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.index_number is not null and new.index_number is distinct from old.index_number and old.state = 'published'
     and new.deleted_at is null then
    insert into index_renumber (tenant_id, workspace_id, node_id, from_number, to_number, renumbered_at)
    values (old.tenant_id, old.workspace_id, old.id, old.index_number, new.index_number, record_clock());
  end if;
  return null;
end $$;

create trigger index_renumber_record after update of index_number on node
  for each row execute function index_renumber_record();

create function index_renumber_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Index renumbering records are never changed';
end $$;
create trigger index_renumber_append_only before update or delete on index_renumber
  for each row execute function index_renumber_append_only();

create table index_renumber_seen (
  tenant_id      uuid not null references tenant(id),
  workspace_id   uuid not null references workspace(id),
  person_id      uuid not null references person(id),
  renumber_id    bigint not null references index_renumber(id),
  first_seen_at  timestamptz not null,
  primary key (person_id, renumber_id)
);
create index index_renumber_seen_room on index_renumber_seen (workspace_id, person_id);

do $$
declare t text;
begin
  foreach t in array array['index_renumber', 'index_renumber_seen'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
  end loop;
end $$;
grant select on index_renumber to vdrkit_app;
grant select, insert on index_renumber_seen to vdrkit_app;

create function mark_renumbers_seen(p_person uuid, p_workspace uuid) returns void
language sql volatile set search_path = public, pg_temp as $$
  insert into index_renumber_seen (tenant_id, workspace_id, person_id, renumber_id, first_seen_at)
  select r.tenant_id, r.workspace_id, p_person, r.id, record_clock()
    from index_renumber r
   where r.workspace_id = p_workspace
     and r.renumbered_at > (select min(m.recorded_at) from membership m join groups g on g.id = m.group_id
                             where m.person_id = p_person and g.workspace_id = p_workspace)
     and not exists (select 1 from index_renumber_seen s where s.person_id = p_person and s.renumber_id = r.id)
  on conflict do nothing
$$;

-- no access check
create function renumbered_tags(p_person uuid, p_workspace uuid)
returns table (node_id uuid, from_number text)
language sql stable set search_path = public, pg_temp as $$
  select t.node_id, t.from_number
    from (select distinct on (r.node_id) r.node_id, r.from_number
            from index_renumber r
            join index_renumber_seen s on s.renumber_id = r.id and s.person_id = p_person
            join workspace w on w.id = r.workspace_id
           where r.workspace_id = p_workspace
             and s.first_seen_at + make_interval(days => w.renumbered_tag_days) > record_clock()
           order by r.node_id, r.renumbered_at, r.id) t
    join node n on n.id = t.node_id
   where n.deleted_at is null and n.index_number is distinct from t.from_number
$$;

grant execute on function mark_renumbers_seen(uuid, uuid) to vdrkit_app;
grant execute on function renumbered_tags(uuid, uuid) to vdrkit_app;
