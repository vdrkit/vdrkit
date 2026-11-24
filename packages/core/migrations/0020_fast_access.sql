-- SPDX-License-Identifier: AGPL-3.0-only
-- Must match effective_level() rule for rule; the core tests compare them.

create or replace function accessible_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  k         timestamptz := coalesce(p_known_at, p_at);
  ws        workspace%rowtype;
  st        text;
  is_seller boolean;
  is_admin  boolean;
  hid       uuid[];
  denied    uuid[];
begin
  if tree_changed_since(p_workspace, least(p_at, k)) then
    return query
      select t.node_id, e.level, e.can_upload, e.can_manage, e.can_publish
        from node_tree_at(p_workspace, p_at, p_known_at) t
        cross join lateral effective_level(p_person, t.node_id, p_at, p_known_at) e
       where e.level > 0 or e.can_upload or e.can_manage or e.can_publish;
    return;
  end if;

  select * into ws from workspace w where w.id = p_workspace;
  if ws.state = 'deleted' then return; end if;
  st := workspace_state_at(p_workspace, p_at, k);

  if not exists (
    select 1 from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = p_workspace and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  ) then
    return;
  end if;

  select bool_or(pa.kind = 'seller'), bool_or(pa.kind = 'seller' and gr.role_template = 'admin')
    into is_seller, is_admin
    from membership m join groups gr on gr.id = m.group_id join party pa on pa.id = gr.party_id
   where m.person_id = p_person and gr.workspace_id = p_workspace and m.status = 'active'
     and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
     and gr.valid_from <= p_at and p_at < gr.valid_to;

  if st = 'preparing' and not is_seller then return; end if;
  if st in ('closed', 'archived') and not is_admin then return; end if;
  if ws.requires_nda and not is_seller and not public.nda_accepted(p_person, ws.id, k) then return; end if;

  -- draft ancestor hides its subtree
  select coalesce(array_agg(x.id), '{}') into hid from node x
   where x.workspace_id = p_workspace and x.state in ('draft', 'withdrawn')
     and exists (select 1 from node c where c.parent_id = x.id);
  select coalesce(array_agg(ag.node_id), '{}') into denied from access_grant ag
   where ag.subject_person_id = p_person and ag.effect = 'deny'
     and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at;

  return query
    with grp as materialized (
      select distinct gr.id, gr.parent_group_id,
             gr.parent_group_id is null or exists (
               select 1 from groups pg where pg.id = gr.parent_group_id and pg.valid_from <= p_at and p_at < pg.valid_to) as parent_ok
        from membership m join groups gr on gr.id = m.group_id
       where m.person_id = p_person and gr.workspace_id = p_workspace and m.status = 'active'
         and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
         and gr.valid_from <= p_at and p_at < gr.valid_to
    ),
    gg as materialized (
      select ag.node_id, ag.subject_group_id, ag.subject_person_id, ag.level, ag.can_upload, ag.can_manage, ag.can_publish
        from access_grant ag
       where ag.effect = 'allow'
         and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
         and (ag.subject_person_id = p_person
              or ag.subject_group_id in (select g.id from grp g)
              or ag.subject_group_id in (select g.parent_group_id from grp g where g.parent_group_id is not null))
    ),
    ruled as (
      select nd.id, barrier_cap(p_person, nd.id, r.level, p_at) as level,
             case when st in ('frozen', 'closed', 'archived') then false else r.upl end as upl, r.mng, r.pub
        from node nd
        -- offset 0: path once per node
        cross join lateral (select path_ids(nd.path) as anc offset 0) p
        cross join lateral (
          select max(x.level)::smallint as level, bool_or(x.can_upload) as upl, bool_or(x.can_manage) as mng,
                 bool_or(x.can_publish) as pub
            from (
              select case when g.parent_group_id is null then n.level else least(n.level, pn.level) end as level,
                     n.can_upload and (g.parent_group_id is null or pn.can_upload) as can_upload,
                     n.can_manage and (g.parent_group_id is null or pn.can_manage) as can_manage,
                     n.can_publish and (g.parent_group_id is null or pn.can_publish) as can_publish
                from grp g
                cross join lateral (
                  select gg.level, gg.can_upload, gg.can_manage, gg.can_publish from gg
                   where gg.subject_group_id = g.id and gg.node_id = any (p.anc)
                   order by array_position(p.anc, gg.node_id) desc limit 1) n
                left join lateral (
                  select gg.level, gg.can_upload, gg.can_manage, gg.can_publish from gg
                   where gg.subject_group_id = g.parent_group_id and gg.node_id = any (p.anc)
                   order by array_position(p.anc, gg.node_id) desc limit 1) pn on true
               where g.parent_group_id is null or (g.parent_ok and pn.level is not null)
              union all
              (select gg.level, gg.can_upload, gg.can_manage, gg.can_publish from gg
                where gg.subject_person_id = p_person and gg.node_id = any (p.anc)
                order by array_position(p.anc, gg.node_id) desc limit 1)
            ) x
        ) r
       where nd.workspace_id = p_workspace and nd.deleted_at is null
         and r.level is not null
         and not (p.anc && denied)
         and (r.upl or r.mng or r.pub or not (nd.state in ('draft', 'withdrawn') or p.anc && hid))
    )
    select r.id, r.level, r.upl, r.mng, r.pub from ruled r
     where r.level > 0 or r.upl or r.mng or r.pub;
end $$;

grant execute on function accessible_nodes(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;
