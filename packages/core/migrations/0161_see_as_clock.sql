-- SPDX-License-Identifier: AGPL-3.0-only
alter table see_as_preview add column app_at timestamptz;

-- backdate stand-in rows: the API clock can lag the db clock. Stand-ins never commit.
-- b_ prefix: must fire after a_record_time
create function see_as_backdate() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  t timestamptz;
begin
  select least(public.record_clock(), coalesce(sp.app_at, public.record_clock())) - interval '1 minute' into t
    from see_as_preview sp where sp.person_id = new.person_id;
  if not found then return new; end if;
  if tg_table_name = 'membership' then
    new.recorded_at := t;
  else
    new.accepted_at := t;
  end if;
  return new;
end $$;

create trigger b_see_as_backdate before insert on membership
  for each row execute function see_as_backdate();
create trigger b_see_as_backdate before insert on acceptance
  for each row execute function see_as_backdate();

create or replace function see_as_begin(p_admin uuid, p_workspace uuid, p_group uuid, p_at timestamptz)
returns table (person_id uuid, group_name text, side text, party_kind text)
language plpgsql volatile set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  t   record;
  adm person%rowtype;
  pid uuid;
begin
  select * into t from public.see_as_teams(p_admin, p_workspace, p_at) s where s.group_id = p_group;
  if not found then return; end if;
  select * into adm from person where id = p_admin;

  insert into person (tenant_id, name, email, time_zone, locale)
  values (current_tenant_id(), adm.name, 'see-as.' || gen_random_uuid() || '@preview.invalid', adm.time_zone, adm.locale)
  returning id into pid;
  -- before membership/acceptance inserts
  insert into see_as_preview (person_id, tenant_id, workspace_id, group_id, admin_person_id, app_at)
  values (pid, current_tenant_id(), p_workspace, p_group, p_admin, p_at);
  insert into membership (tenant_id, person_id, group_id, role) values (current_tenant_id(), pid, p_group, 'member');

  -- all versions, either clock
  insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at)
  select current_tenant_id(), av.id, pid, record_clock()
    from agreement_version av join agreement a on a.id = av.agreement_id
   where a.workspace_id = p_workspace and a.kind = 'nda' and av.published_at <= greatest(p_at, record_clock());

  return query select pid, t.name, t.side, t.party_kind;
end $$;
