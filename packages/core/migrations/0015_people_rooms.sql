-- SPDX-License-Identifier: AGPL-3.0-only

-- backfills cross tenants
alter table person no force row level security;
alter table workspace no force row level security;

alter table person add column given_name  text not null default '';
alter table person add column family_name text not null default '';
alter table person add column company     text;
alter table person add column job_title   text;

update person
   set given_name  = case when erased_at is null and position('@' in name) = 0 then split_part(btrim(name), ' ', 1) else '' end,
       family_name = case when erased_at is null and position('@' in name) = 0 and position(' ' in btrim(name)) > 0
                          then btrim(substr(btrim(name), position(' ' in btrim(name)) + 1)) else '' end;

create function person_names() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  parts_given boolean;
begin
  if tg_op = 'INSERT' then
    parts_given := coalesce(new.given_name, '') <> '' or coalesce(new.family_name, '') <> '';
  else
    parts_given := (new.given_name, new.family_name) is distinct from (old.given_name, old.family_name);
  end if;
  new.given_name := btrim(coalesce(new.given_name, ''));
  new.family_name := btrim(coalesce(new.family_name, ''));
  if parts_given then
    new.name := btrim(new.given_name || ' ' || new.family_name);
  elsif tg_op = 'INSERT' or new.name is distinct from old.name then
    if new.name is not null and position('@' in new.name) = 0 then
      new.given_name := split_part(btrim(new.name), ' ', 1);
      new.family_name := case when position(' ' in btrim(new.name)) > 0
                              then btrim(substr(btrim(new.name), position(' ' in btrim(new.name)) + 1)) else '' end;
    end if;
  end if;
  if new.erased_at is not null then
    new.given_name := '';
    new.family_name := '';
    new.company := null;
    new.job_title := null;
  end if;
  return new;
end $$;

create trigger a_person_names before insert or update on person
  for each row execute function person_names();

alter table event_context add column personal jsonb;
alter table event_context add column subject_person_id uuid;
create index event_context_subject on event_context (subject_person_id) where subject_person_id is not null;

-- only ids are hashed; chain survives erasure
create function person_erase_context() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.erased_at is not null and old.erased_at is null then
    update event_context set personal = null where subject_person_id = new.id and personal is not null;
  end if;
  return null;
end $$;

create trigger person_erase_context after update of erased_at on person
  for each row execute function person_erase_context();

-- preparing: seller party only
-- frozen: read-only, withdraw still allowed
-- closed: admins only

alter table workspace drop constraint workspace_state_check;
update workspace set state = case state when 'draft' then 'preparing' when 'active' then 'open' when 'closed' then 'frozen' else state end;
alter table workspace add constraint workspace_state_check
  check (state in ('preparing', 'open', 'frozen', 'closed', 'archived', 'deleted'));
alter table workspace alter column state set default 'preparing';

create function workspace_state_names() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.state := case new.state when 'draft' then 'preparing' when 'active' then 'open' else new.state end;
  return new;
end $$;

create trigger a_workspace_state_names before insert or update of state on workspace
  for each row execute function workspace_state_names();

update workspace set metadata = metadata - 'hide_names_in_email' where metadata ? 'hide_names_in_email';

create table workspace_state_history (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  state         text not null,
  valid_from    timestamptz not null,
  recorded_at   timestamptz not null
);
create index workspace_state_history_ws on workspace_state_history (workspace_id, valid_from desc, id desc);

insert into workspace_state_history (tenant_id, workspace_id, state, valid_from, recorded_at)
select tenant_id, id, state, '-infinity', created_at from workspace;

alter table workspace_state_history enable row level security;
alter table workspace_state_history force row level security;
create policy tenant_isolation on workspace_state_history
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select on workspace_state_history to vdrkit_app;

create function workspace_state_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t   timestamptz := public.record_clock();
  vf  timestamptz;
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return null;
  end if;
  if tg_op = 'INSERT' then
    vf := '-infinity';
  else
    vf := coalesce(nullif(current_setting('vdrkit.state_valid_from', true), '')::timestamptz, t);
  end if;
  insert into workspace_state_history (tenant_id, workspace_id, state, valid_from, recorded_at)
  values (new.tenant_id, new.id, new.state, vf, t);
  return null;
end $$;

create trigger workspace_state_record after insert or update of state on workspace
  for each row execute function workspace_state_record();

create function workspace_state_history_append_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Room state history is never changed';
end $$;
create trigger workspace_state_history_append_only before update or delete on workspace_state_history
  for each row execute function workspace_state_history_append_only();

create function workspace_state_at(p_workspace uuid, p_at timestamptz, p_known_at timestamptz default null)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select h.state from workspace_state_history h
      where h.workspace_id = p_workspace and h.valid_from <= p_at and h.recorded_at <= coalesce(p_known_at, p_at)
      order by h.valid_from desc, h.id desc limit 1),
    (select w.state from workspace w where w.id = p_workspace))
$$;

alter table agreement_version add column requires_reacceptance boolean not null default true;

-- corrections since the last full version: any acceptance from it counts
create function nda_accepted(p_person uuid, p_workspace uuid, p_known_at timestamptz)
returns boolean language sql stable set search_path = public, pg_temp as $$
  with versions as (
    select av.id, av.version_no, av.published_at, av.requires_reacceptance
      from public.agreement_version av join public.agreement a on a.id = av.agreement_id
     where a.workspace_id = p_workspace and a.kind = 'nda' and av.published_at <= p_known_at
  ), base as (
    select v.version_no, v.published_at from versions v
     where v.requires_reacceptance or v.version_no = (select min(version_no) from versions)
     order by v.published_at desc, v.version_no desc limit 1
  )
  select not exists (select 1 from public.agreement a where a.workspace_id = p_workspace and a.kind = 'nda')
      or exists (
        select 1 from public.acceptance ac join versions v on v.id = ac.agreement_version_id cross join base b
         where ac.person_id = p_person and ac.accepted_at <= p_known_at
           and (v.published_at, v.version_no) >= (b.published_at, b.version_no))
$$;
grant execute on function nda_accepted(uuid, uuid, timestamptz) to vdrkit_app;

-- frozen: publishers keep the switch to withdraw

create or replace function effective_level(
  p_person    uuid,
  p_node      uuid,
  p_at        timestamptz default now(),
  p_known_at  timestamptz default null
) returns table (level smallint, can_upload boolean, can_manage boolean, can_publish boolean, reason text)
language plpgsql stable as $$
declare
  k         timestamptz := coalesce(p_known_at, p_at);
  ws_id     uuid;
  npath     ltree;
  anc       uuid[];
  hidden    boolean;
  ws        workspace%rowtype;
  st        text;
  lvl       smallint := 0;
  upl       boolean := false;
  mng       boolean := false;
  pub       boolean := false;
  why       text := 'no_grant';
  is_seller boolean;
  is_admin  boolean;
  g         record;
  gl        record;
  pl        record;
  r         record;
begin
  select nd.workspace_id into ws_id from node nd where nd.id = p_node;
  if ws_id is null then
    return query select 0::smallint, false, false, false, 'node_not_found'; return;
  end if;

  if not tree_changed_since(ws_id, least(p_at, k)) then
    select nd.path into npath from node nd where nd.id = p_node and nd.deleted_at is null;
    if npath is null then
      return query select 0::smallint, false, false, false, 'node_not_found'; return;
    end if;
    anc := path_ids(npath);
    select exists (select 1 from node a where a.id = any (anc) and a.state in ('draft', 'withdrawn')) into hidden;
  else
    select na.path into npath from node_at(p_node, p_at, k) na where na.deleted_at is null;
    if npath is null then
      return query select 0::smallint, false, false, false, 'node_not_found'; return;
    end if;
    anc := path_ids(npath);
    select exists (select 1 from unnest(anc) a(id) cross join lateral node_at(a.id, p_at, k) na
                    where na.state in ('draft', 'withdrawn')) into hidden;
  end if;

  select * into ws from workspace where id = ws_id;
  if ws.state = 'deleted' then
    return query select 0::smallint, false, false, false, 'workspace_deleted'; return;
  end if;
  st := workspace_state_at(ws_id, p_at, k);

  if not exists (
    select 1 from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = ws_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  ) then
    return query select 0::smallint, false, false, false, 'no_membership'; return;
  end if;

  select bool_or(pa.kind = 'seller'), bool_or(pa.kind = 'seller' and gr.role_template = 'admin')
    into is_seller, is_admin
    from membership m join groups gr on gr.id = m.group_id join party pa on pa.id = gr.party_id
   where m.person_id = p_person and gr.workspace_id = ws_id and m.status = 'active'
     and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
     and gr.valid_from <= p_at and p_at < gr.valid_to;

  if st = 'preparing' and not is_seller then
    return query select 0::smallint, false, false, false, 'room_preparing'; return;
  end if;
  if st in ('closed', 'archived') and not is_admin then
    return query select 0::smallint, false, false, false, 'room_closed'; return;
  end if;

  if ws.requires_nda and not is_seller and not public.nda_accepted(p_person, ws.id, k) then
    return query select 0::smallint, false, false, false, 'nda_not_accepted'; return;
  end if;

  select ag.id into r from access_grant ag
  where ag.subject_person_id = p_person and ag.effect = 'deny' and ag.node_id = any (anc)
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  limit 1;
  if found then
    return query select 0::smallint, false, false, false, 'deny:' || r.id; return;
  end if;

  for g in
    select distinct gr.id, gr.parent_group_id from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = ws_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  loop
    select ag.id, ag.level, ag.can_upload, ag.can_manage, ag.can_publish into gl
    from access_grant ag
    where ag.subject_group_id = g.id and ag.effect = 'allow' and ag.node_id = any (anc)
      and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
    order by array_position(anc, ag.node_id) desc limit 1;
    continue when not found;

    if g.parent_group_id is not null then
      if not exists (select 1 from groups pg where pg.id = g.parent_group_id and pg.valid_from <= p_at and p_at < pg.valid_to) then
        continue;
      end if;
      select ag.level, ag.can_upload, ag.can_manage, ag.can_publish into pl
      from access_grant ag
      where ag.subject_group_id = g.parent_group_id and ag.effect = 'allow' and ag.node_id = any (anc)
        and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
      order by array_position(anc, ag.node_id) desc limit 1;
      if not found then
        continue;
      end if;
      gl.level := least(gl.level, pl.level);
      gl.can_upload := gl.can_upload and pl.can_upload;
      gl.can_manage := gl.can_manage and pl.can_manage;
      gl.can_publish := gl.can_publish and pl.can_publish;
    end if;

    if gl.level > lvl or (gl.level = lvl and why = 'no_grant') then
      lvl := gl.level; why := 'grant:' || gl.id;
    end if;
    upl := upl or gl.can_upload;
    mng := mng or gl.can_manage;
    pub := pub or gl.can_publish;
  end loop;

  select ag.id, ag.level, ag.can_upload, ag.can_manage, ag.can_publish into gl
  from access_grant ag
  where ag.subject_person_id = p_person and ag.effect = 'allow' and ag.node_id = any (anc)
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  order by array_position(anc, ag.node_id) desc limit 1;
  if found then
    if gl.level > lvl then lvl := gl.level; why := 'grant:' || gl.id; end if;
    upl := upl or gl.can_upload;
    mng := mng or gl.can_manage;
    pub := pub or gl.can_publish;
  end if;

  if hidden and not (mng or upl or pub) then
    return query select 0::smallint, false, false, false, 'not_published'; return;
  end if;

  lvl := barrier_cap(p_person, p_node, lvl, p_at);

  if st in ('frozen', 'closed', 'archived') then
    upl := false;
  end if;

  if lvl = 0 and not (upl or mng or pub) then
    return query select 0::smallint, false, false, false, why; return;
  end if;
  return query select lvl, upl, mng, pub, why;
end $$;

grant execute on function workspace_state_at(uuid, timestamptz, timestamptz) to vdrkit_app;
grant execute on function nda_accepted(uuid, uuid, timestamptz) to vdrkit_app;
grant execute on function effective_level(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;

alter table approval drop constraint approval_kind_check;
alter table approval add constraint approval_kind_check
  check (kind in ('colleague_request', 'removal_request', 'agent_action', 'other'));

create unique index approval_one_pending_removal on approval (group_id, (payload ->> 'person_id'))
  where kind = 'removal_request' and status = 'pending';

alter table approval no force row level security;
update approval a set status = 'withdrawn'
 where a.kind = 'colleague_request' and a.status = 'pending'
   and exists (select 1 from approval b where b.kind = 'colleague_request' and b.status = 'pending' and b.group_id = a.group_id
                  and lower(b.payload ->> 'email') = lower(a.payload ->> 'email') and (b.created_at, b.id) < (a.created_at, a.id));
create unique index approval_one_pending_colleague on approval (group_id, lower(payload ->> 'email'))
  where kind = 'colleague_request' and status = 'pending';
alter table approval force row level security;

create function stamp_approval_times() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := public.record_clock();
    new.decided_at := case when new.status = 'pending' then null else public.record_clock() end;
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'A decided request never changes' using errcode = 'insufficient_privilege';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  new.decided_at := case when new.status = 'pending' then null else public.record_clock() end;
  return new;
end $$;

create trigger a_record_time before insert or update on approval
  for each row execute function stamp_approval_times();

alter table person force row level security;
alter table workspace force row level security;
