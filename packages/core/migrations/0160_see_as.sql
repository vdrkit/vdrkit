-- SPDX-License-Identifier: AGPL-3.0-only
-- see-as: stand-in member of the team, inside a transaction the API always rolls back.
-- A see_as_preview row must never commit
create table see_as_preview (
  person_id        uuid primary key references person(id),
  tenant_id        uuid not null references tenant(id),
  workspace_id     uuid not null references workspace(id),
  group_id         uuid not null references groups(id),
  admin_person_id  uuid not null references person(id)
);
alter table see_as_preview enable row level security;
alter table see_as_preview force row level security;
create policy tenant_isolation on see_as_preview using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert on see_as_preview to vdrkit_app;

create function see_as_never_saved() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'A see-as preview is read only and is never saved' using errcode = 'insufficient_privilege';
end $$;

-- deferred: only fires at commit
create constraint trigger see_as_never_saved after insert on see_as_preview
  deferrable initially deferred for each row execute function see_as_never_saved();

create function see_as_teams(p_admin uuid, p_workspace uuid, p_at timestamptz)
returns table (group_id uuid, name text, parent_group_id uuid, side text, party_kind text, role_template text)
language sql stable set search_path = public, pg_temp as $$
  select g.id, g.name, g.parent_group_id,
         case when pa.kind in ('bidder', 'financier') then 'bidders' else 'seller' end,
         pa.kind, g.role_template
    from groups g join party pa on pa.id = g.party_id
   where public.is_workspace_admin(p_admin, p_workspace, p_at)
     and g.workspace_id = p_workspace and g.role_template <> 'admin'
     and g.valid_from <= p_at and p_at < g.valid_to
     and (g.parent_group_id is null or exists (
           select 1 from groups pg where pg.id = g.parent_group_id and pg.valid_from <= p_at and p_at < pg.valid_to))
$$;

-- only call inside a transaction that gets rolled back
create function see_as_begin(p_admin uuid, p_workspace uuid, p_group uuid, p_at timestamptz)
returns table (person_id uuid, group_name text, side text, party_kind text)
language plpgsql volatile set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  t   record;
  adm person%rowtype;
  pid uuid;
  v   uuid;
begin
  select * into t from public.see_as_teams(p_admin, p_workspace, p_at) s where s.group_id = p_group;
  if not found then return; end if;
  select * into adm from person where id = p_admin;

  -- .invalid never delivers
  insert into person (tenant_id, name, email, time_zone, locale)
  values (current_tenant_id(), adm.name, 'see-as.' || gen_random_uuid() || '@preview.invalid', adm.time_zone, adm.locale)
  returning id into pid;
  insert into see_as_preview (person_id, tenant_id, workspace_id, group_id, admin_person_id)
  values (pid, current_tenant_id(), p_workspace, p_group, p_admin);
  -- not lead (leads see team reading)
  insert into membership (tenant_id, person_id, group_id, role) values (current_tenant_id(), pid, p_group, 'member');

  select av.id into v from agreement_version av join agreement a on a.id = av.agreement_id
   where a.workspace_id = p_workspace and a.kind = 'nda' and av.published_at <= record_clock()
   order by av.published_at desc, av.version_no desc limit 1;
  if v is not null then
    insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values (current_tenant_id(), v, pid, record_clock());
  end if;

  return query select pid, t.name, t.side, t.party_kind;
end $$;

grant execute on function see_as_teams(uuid, uuid, timestamptz) to vdrkit_app;
grant execute on function see_as_begin(uuid, uuid, uuid, timestamptz) to vdrkit_app;
