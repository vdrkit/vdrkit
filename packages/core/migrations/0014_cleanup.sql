-- SPDX-License-Identifier: AGPL-3.0-only

alter table document_version add column released_at timestamptz;
alter table document_version add column released_by uuid references person(id);
alter table document_version add column withdrawn_at timestamptz;
alter table document_version add column withdrawn_by uuid references person(id);
alter table document_version add constraint document_version_release_state
  check (not (awaiting_release and released_at is not null));

create function stamp_version_state() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.released_at is not null then new.released_at := public.record_clock(); end if;
    if new.withdrawn_at is not null then new.withdrawn_at := public.record_clock(); end if;
    return new;
  end if;
  if new.released_at is distinct from old.released_at then
    if old.released_at is not null then
      raise exception 'A version is released only once' using errcode = 'insufficient_privilege';
    end if;
    new.released_at := public.record_clock();
  end if;
  if new.withdrawn_at is distinct from old.withdrawn_at then
    if old.withdrawn_at is not null then
      raise exception 'A version is withdrawn only once' using errcode = 'insufficient_privilege';
    end if;
    new.withdrawn_at := public.record_clock();
  end if;
  return new;
end $$;

create trigger b_version_state before insert or update on document_version
  for each row execute function stamp_version_state();

-- known-at only
create function version_withdrawn(p_withdrawn_at timestamptz, p_at timestamptz, p_known_at timestamptz default null)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_withdrawn_at is not null and p_withdrawn_at <= coalesce(p_known_at, p_at)
$$;

-- released_at null: group list alone decides
create function version_released(
  p_released_at timestamptz, p_withdrawn_at timestamptz, p_at timestamptz, p_known_at timestamptz default null
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select (p_released_at is null or p_released_at <= coalesce(p_known_at, p_at))
     and not version_withdrawn(p_withdrawn_at, p_at, p_known_at)
$$;

create or replace function visible_version(
  p_person uuid, p_node uuid, p_at timestamptz default now(), p_known_at timestamptz default null, p_agent boolean default false
) returns uuid language plpgsql stable set search_path = public, pg_temp as $$
declare
  ws   uuid;
  e    record;
  all_ boolean;
  v    uuid;
begin
  select n.workspace_id into ws from node n where n.id = p_node and n.deleted_at is null and n.kind = 'document';
  if ws is null then return null; end if;
  select * into e from effective_level(p_person, p_node, p_at, p_known_at);
  if coalesce(p_agent, false) then
    if e.level = 0 then return null; end if;
  elsif e.level = 0 and not (e.can_upload or e.can_manage or e.can_publish) then
    return null;
  end if;
  all_ := sees_all_versions(e.can_upload, e.can_manage, e.can_publish, is_workspace_admin(p_person, ws, p_at), p_agent);
  select dv.id into v from document_version dv
   where dv.node_id = p_node and not version_withdrawn(dv.withdrawn_at, p_at, p_known_at)
     and (all_ or (version_released(dv.released_at, dv.withdrawn_at, p_at, p_known_at)
                   and version_visible(p_person, ws, dv.visible_to_group_ids, p_at, p_known_at)))
   order by dv.version_no desc limit 1;
  return v;
end $$;

create or replace function can_see_version(
  p_person uuid, p_version uuid, p_at timestamptz default now(), p_known_at timestamptz default null, p_agent boolean default false
) returns boolean language plpgsql stable set search_path = public, pg_temp as $$
declare
  dv   document_version%rowtype;
  ws   uuid;
  e    record;
begin
  select * into dv from document_version where id = p_version;
  if not found then return false; end if;
  select n.workspace_id into ws from node n where n.id = dv.node_id and n.deleted_at is null;
  if ws is null then return false; end if;
  select * into e from effective_level(p_person, dv.node_id, p_at, p_known_at);
  if coalesce(p_agent, false) then
    if e.level = 0 then return false; end if;
  elsif e.level = 0 and not (e.can_upload or e.can_manage or e.can_publish) then
    return false;
  end if;
  -- seller side may still open a withdrawn version
  return sees_all_versions(e.can_upload, e.can_manage, e.can_publish, is_workspace_admin(p_person, ws, p_at), p_agent)
      or (version_released(dv.released_at, dv.withdrawn_at, p_at, p_known_at)
          and version_visible(p_person, ws, dv.visible_to_group_ids, p_at, p_known_at));
end $$;

create or replace function readable_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null, p_agent boolean default false
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean, version_id uuid)
language sql stable set search_path = public, pg_temp as $$
  with adm as materialized (select is_workspace_admin(p_person, p_workspace, p_at) as yes)
  select a.node_id, a.level, a.can_upload, a.can_manage, a.can_publish, vv.id
    from accessible_nodes(p_person, p_workspace, p_at, p_known_at) a
    cross join adm
    left join lateral (
      select dv.id from document_version dv
       where dv.node_id = a.node_id and not version_withdrawn(dv.withdrawn_at, p_at, p_known_at)
         and (sees_all_versions(a.can_upload, a.can_manage, a.can_publish, adm.yes, p_agent)
              or (version_released(dv.released_at, dv.withdrawn_at, p_at, p_known_at)
                  and version_visible(p_person, p_workspace, dv.visible_to_group_ids, p_at, p_known_at)))
       order by dv.version_no desc limit 1) vv on true
   where vv.id is not null
      or not exists (select 1 from document_version d2 where d2.node_id = a.node_id)
$$;

grant execute on function version_withdrawn(timestamptz, timestamptz, timestamptz) to vdrkit_app;
grant execute on function version_released(timestamptz, timestamptz, timestamptz, timestamptz) to vdrkit_app;

-- worker runs as vdrkit_app and sees nothing without a tenant; RLS is forced on the owner too
-- not a SET clause: custom settings there need superuser
-- policy: owner only, and only while this function runs

create policy due_tenant_listing on notification for select
  using (current_setting('vdrkit.due_tenant_listing', true) = 'on');
do $$ begin
  execute format('alter policy due_tenant_listing on notification to %I', current_user);
end $$;

create function tenants_with_due_notifications(p_now timestamptz default now())
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.due_tenant_listing', true), '');
begin
  perform set_config('vdrkit.due_tenant_listing', 'on', true);
  return query
    select distinct n.tenant_id from notification n where n.status = 'open' and n.due_at <= p_now order by n.tenant_id;
  perform set_config('vdrkit.due_tenant_listing', prior, true);
end $$;

revoke all on function tenants_with_due_notifications(timestamptz) from public;
grant execute on function tenants_with_due_notifications(timestamptz) to vdrkit_app;

create function stamp_published_at() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.published_at := public.record_clock();
  elsif new.published_at is distinct from old.published_at then
    raise exception 'published_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create function stamp_accepted_at() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.accepted_at := public.record_clock();
  elsif new.accepted_at is distinct from old.accepted_at then
    raise exception 'accepted_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger a_record_time before insert or update on agreement_version
  for each row execute function stamp_published_at();
create trigger a_record_time before insert or update on acceptance
  for each row execute function stamp_accepted_at();

alter table node_history add column sort_key integer;

create or replace function node_history_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t timestamptz := public.record_clock();
  r node%rowtype;
begin
  if tg_op = 'UPDATE' and (old.parent_id, old.kind, old.name, old.index_number, old.state, old.path, old.deleted_at, old.sort_key)
       is not distinct from (new.parent_id, new.kind, new.name, new.index_number, new.state, new.path, new.deleted_at, new.sort_key) then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select greatest(t, max(h.valid_from)) into t from node_history h where h.node_id = old.id;
    update node_history set valid_to = t where node_id = old.id and valid_to = 'infinity';
  end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  insert into node_history (tenant_id, workspace_id, node_id, parent_id, kind, name, index_number, state, path,
                            deleted_at, sort_key, op, valid_from, recorded_at)
  values (r.tenant_id, r.workspace_id, r.id, r.parent_id, r.kind, r.name, r.index_number, r.state, r.path,
          case when tg_op = 'DELETE' then coalesce(r.deleted_at, t) else r.deleted_at end, r.sort_key,
          lower(tg_op), t, t);
  return null;
end $$;

-- pinned: pgboss schema could otherwise shadow record_clock()

create or replace function db_clock_pin() returns timestamptz language sql stable
set search_path = public, pg_temp as $$
  select null::timestamptz
$$;

create or replace function record_clock() returns timestamptz language sql stable
set search_path = public, pg_temp as $$
  select coalesce(public.db_clock_pin(), pg_catalog.now())
$$;

create or replace function event_clock() returns timestamptz language sql volatile
set search_path = public, pg_temp as $$
  select coalesce(public.db_clock_pin(), pg_catalog.clock_timestamp())
$$;

create or replace function stamp_record_time() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_at := public.record_clock();
    if new.superseded_at < new.recorded_at then
      raise exception 'A row cannot be superseded before it was recorded' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.recorded_at is distinct from old.recorded_at then
    raise exception 'recorded_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  if new.superseded_at is distinct from old.superseded_at then
    if old.superseded_at <> 'infinity' then
      raise exception 'This row is already superseded' using errcode = 'insufficient_privilege';
    end if;
    new.superseded_at := public.record_clock();
  end if;
  return new;
end $$;

create or replace function stamp_created_at() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := public.record_clock();
  elsif new.created_at is distinct from old.created_at then
    raise exception 'created_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- security definer: check the tenant by hand

create or replace function append_event(
  p_action          text,
  p_workspace_id    uuid default null,
  p_actor_id        uuid default null,
  p_on_behalf_of_id uuid default null,
  p_resource_type   text default null,
  p_resource_id     uuid default null,
  p_data            jsonb default '{}',
  p_request_id      text default null,
  p_occurred_at     timestamptz default null
) returns event language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t     uuid := public.current_tenant_id();
  ck    uuid;
  c     event_chain%rowtype;
  e     event;
  last  timestamptz;
begin
  if t is null then
    raise exception 'No tenant set for this transaction';
  end if;
  if p_workspace_id is not null
     and not exists (select 1 from workspace w where w.id = p_workspace_id and w.tenant_id = t) then
    raise exception 'This workspace does not belong to the current tenant' using errcode = 'insufficient_privilege';
  end if;
  ck := coalesce(p_workspace_id, t);

  insert into event_counter (tenant_id) values (t) on conflict do nothing;
  update event_counter set last_seq = last_seq + 1 where tenant_id = t returning last_seq into e.seq;

  insert into event_chain (tenant_id, chain_key) values (t, ck) on conflict do nothing;
  select * into c from event_chain where chain_key = ck and tenant_id = t for update;
  if not found then
    raise exception 'This event chain does not belong to the current tenant' using errcode = 'insufficient_privilege';
  end if;

  select ev.occurred_at into last from event ev where ev.tenant_id = t and ev.chain_key = ck and ev.chain_pos = c.length;

  e.id := gen_random_uuid();
  e.tenant_id := t;
  e.chain_key := ck;
  e.chain_pos := c.length + 1;
  e.occurred_at := greatest(public.event_clock(), last);
  e.workspace_id := p_workspace_id;
  e.actor_id := p_actor_id;
  e.on_behalf_of_id := p_on_behalf_of_id;
  e.action := p_action;
  e.resource_type := p_resource_type;
  e.resource_id := p_resource_id;
  e.data := coalesce(p_data, '{}');
  e.request_id := p_request_id;
  e.prev_hash := c.head_hash;
  e.hash := public.event_hash(c.head_hash, e);

  insert into event select e.*;
  update event_chain set length = e.chain_pos, head_hash = e.hash where chain_key = ck and tenant_id = t;
  return e;
end $$;

revoke all on function append_event(text, uuid, uuid, uuid, text, uuid, jsonb, text, timestamptz) from public;
grant execute on function append_event(text, uuid, uuid, uuid, text, uuid, jsonb, text, timestamptz) to vdrkit_app;
