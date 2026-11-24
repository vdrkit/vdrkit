-- SPDX-License-Identifier: AGPL-3.0-only
-- every route that picks a version for a reader must use these. Agents never see all versions

create function sees_all_versions(
  p_can_upload boolean, p_can_manage boolean, p_can_publish boolean, p_is_admin boolean, p_agent boolean
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select not coalesce(p_agent, false) and (coalesce(p_can_upload, false) or coalesce(p_can_manage, false)
         or coalesce(p_can_publish, false) or coalesce(p_is_admin, false))
$$;

create function version_visible(
  p_person uuid, p_workspace uuid, p_groups uuid[], p_at timestamptz, p_known_at timestamptz default null
) returns boolean language sql stable set search_path = public, pg_temp as $$
  select cardinality(p_groups) = 0 or exists (
    select 1 from membership m join groups g on g.id = m.group_id
     where m.person_id = p_person and g.workspace_id = p_workspace and m.status = 'active'
       and m.valid_from <= p_at and p_at < m.valid_to
       and m.recorded_at <= coalesce(p_known_at, p_at) and coalesce(p_known_at, p_at) < m.superseded_at
       and g.valid_from <= p_at and p_at < g.valid_to
       and (g.id = any (p_groups) or g.parent_group_id = any (p_groups)))
$$;

create function visible_version(
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
   where dv.node_id = p_node and (all_ or version_visible(p_person, ws, dv.visible_to_group_ids, p_at, p_known_at))
   order by dv.version_no desc limit 1;
  return v;
end $$;

create function can_see_version(
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
  return sees_all_versions(e.can_upload, e.can_manage, e.can_publish, is_workspace_admin(p_person, ws, p_at), p_agent)
      or version_visible(p_person, ws, dv.visible_to_group_ids, p_at, p_known_at);
end $$;

create function readable_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null, p_agent boolean default false
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean, version_id uuid)
language sql stable set search_path = public, pg_temp as $$
  with adm as materialized (select is_workspace_admin(p_person, p_workspace, p_at) as yes)
  select a.node_id, a.level, a.can_upload, a.can_manage, a.can_publish, vv.id
    from accessible_nodes(p_person, p_workspace, p_at, p_known_at) a
    cross join adm
    left join lateral (
      select dv.id from document_version dv
       where dv.node_id = a.node_id
         and (sees_all_versions(a.can_upload, a.can_manage, a.can_publish, adm.yes, p_agent)
              or version_visible(p_person, p_workspace, dv.visible_to_group_ids, p_at, p_known_at))
       order by dv.version_no desc limit 1) vv on true
   where vv.id is not null
      or not exists (select 1 from document_version d2 where d2.node_id = a.node_id)
$$;

alter table notification_item add column version_id uuid references document_version(id);

grant execute on function sees_all_versions(boolean, boolean, boolean, boolean, boolean) to vdrkit_app;
grant execute on function version_visible(uuid, uuid, uuid[], timestamptz, timestamptz) to vdrkit_app;
grant execute on function visible_version(uuid, uuid, timestamptz, timestamptz, boolean) to vdrkit_app;
grant execute on function can_see_version(uuid, uuid, timestamptz, timestamptz, boolean) to vdrkit_app;
grant execute on function readable_nodes(uuid, uuid, timestamptz, timestamptz, boolean) to vdrkit_app;
