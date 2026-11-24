-- SPDX-License-Identifier: AGPL-3.0-only

alter table access_grant add column can_publish boolean not null default false;

-- nobody publishes a version they uploaded, admins included
alter table workspace add column four_eyes_publish boolean not null default false;

-- return type cannot change in place: drop callers first, recreate. Bodies = previous version plus the publish switch
drop function accessible_nodes(uuid, uuid, timestamptz, timestamptz);
drop function effective_level(uuid, uuid, timestamptz, timestamptz);

create function effective_level(
  p_person    uuid,
  p_node      uuid,
  p_at        timestamptz default now(),
  p_known_at  timestamptz default null
) returns table (level smallint, can_upload boolean, can_manage boolean, can_publish boolean, reason text)
language plpgsql stable as $$
declare
  k         timestamptz := coalesce(p_known_at, p_at);
  n         node%rowtype;
  ws        workspace%rowtype;
  lvl       smallint := 0;
  upl       boolean := false;
  mng       boolean := false;
  pub       boolean := false;
  why       text := 'no_grant';
  is_seller boolean;
  g         record;
  gl        record;
  pl        record;
  r         record;
begin
  select * into n from node where id = p_node and deleted_at is null;
  if not found then
    return query select 0::smallint, false, false, false, 'node_not_found'; return;
  end if;
  select * into ws from workspace where id = n.workspace_id;
  if ws.state = 'deleted' then
    return query select 0::smallint, false, false, false, 'workspace_deleted'; return;
  end if;

  if not exists (
    select 1 from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = n.workspace_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  ) then
    return query select 0::smallint, false, false, false, 'no_membership'; return;
  end if;

  select exists (
    select 1 from membership m join groups gr on gr.id = m.group_id join party pa on pa.id = gr.party_id
    where m.person_id = p_person and gr.workspace_id = n.workspace_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
      and pa.kind = 'seller'
  ) into is_seller;

  if ws.requires_nda and not is_seller then
    if exists (select 1 from agreement a where a.workspace_id = ws.id and a.kind = 'nda') and not exists (
      select 1 from acceptance ac
      where ac.person_id = p_person and ac.accepted_at <= p_at
        and ac.agreement_version_id = (
          select av.id from agreement_version av join agreement a on a.id = av.agreement_id
          where a.workspace_id = ws.id and a.kind = 'nda' and av.published_at <= p_at
          order by av.published_at desc, av.version_no desc limit 1)
    ) then
      return query select 0::smallint, false, false, false, 'nda_not_accepted'; return;
    end if;
  end if;

  select ag.id into r from access_grant ag join node a on a.id = ag.node_id
  where ag.subject_person_id = p_person and ag.effect = 'deny' and a.path @> n.path
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  limit 1;
  if found then
    return query select 0::smallint, false, false, false, 'deny:' || r.id; return;
  end if;

  for g in
    select distinct gr.id, gr.parent_group_id from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = n.workspace_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  loop
    select ag.id, ag.level, ag.can_upload, ag.can_manage, ag.can_publish into gl
    from access_grant ag join node a on a.id = ag.node_id
    where ag.subject_group_id = g.id and ag.effect = 'allow' and a.path @> n.path
      and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
    order by nlevel(a.path) desc limit 1;
    continue when not found;

    if g.parent_group_id is not null then
      if not exists (select 1 from groups pg where pg.id = g.parent_group_id and pg.valid_from <= p_at and p_at < pg.valid_to) then
        continue;
      end if;
      select ag.level, ag.can_upload, ag.can_manage, ag.can_publish into pl
      from access_grant ag join node a on a.id = ag.node_id
      where ag.subject_group_id = g.parent_group_id and ag.effect = 'allow' and a.path @> n.path
        and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
      order by nlevel(a.path) desc limit 1;
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
  from access_grant ag join node a on a.id = ag.node_id
  where ag.subject_person_id = p_person and ag.effect = 'allow' and a.path @> n.path
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  order by nlevel(a.path) desc limit 1;
  if found then
    if gl.level > lvl then lvl := gl.level; why := 'grant:' || gl.id; end if;
    upl := upl or gl.can_upload;
    mng := mng or gl.can_manage;
    pub := pub or gl.can_publish;
  end if;

  if exists (select 1 from node a where a.path @> n.path and a.state in ('draft', 'withdrawn')) and not (mng or upl or pub) then
    return query select 0::smallint, false, false, false, 'not_published'; return;
  end if;

  lvl := barrier_cap(p_person, p_node, lvl, p_at);

  if ws.state in ('closed', 'archived') then
    upl := false;
  end if;

  if lvl = 0 and not (upl or mng or pub) then
    return query select 0::smallint, false, false, false, why; return;
  end if;
  return query select lvl, upl, mng, pub, why;
end $$;

create function accessible_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean)
language sql stable as $$
  select nd.id, e.level, e.can_upload, e.can_manage, e.can_publish
  from node nd cross join lateral effective_level(p_person, nd.id, p_at, p_known_at) e
  where nd.workspace_id = p_workspace and nd.deleted_at is null and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish)
$$;

grant execute on function effective_level(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;
grant execute on function accessible_nodes(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;
