-- SPDX-License-Identifier: AGPL-3.0-only
-- per-group levels for the permission matrix
-- not an access check, see effective_level()

create function group_access_matrix(p_workspace uuid, p_at timestamptz, p_known_at timestamptz default null)
returns table (group_id uuid, node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean,
               source_node_id uuid, capped boolean)
language plpgsql stable set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  k       timestamptz := coalesce(p_known_at, p_at);
  changed boolean := tree_changed_since(p_workspace, least(p_at, coalesce(p_known_at, p_at)));
begin
  return query
  with tree as (
    select n.id, n.kind, n.path from node n where not changed and n.workspace_id = p_workspace and n.deleted_at is null
    union all
    select t.node_id, t.kind, t.path from node_tree_at(p_workspace, p_at, k) t where changed
  ), gr as (
    select g.id, g.parent_group_id from groups g
     where g.workspace_id = p_workspace and g.valid_from <= p_at and p_at < g.valid_to
  ), ag as (
    select a.id, a.node_id, a.subject_group_id, a.level, a.can_upload, a.can_manage, a.can_publish, t.path
      from access_grant a join tree t on t.id = a.node_id
     where a.workspace_id = p_workspace and a.subject_group_id is not null and a.effect = 'allow'
       and a.valid_from <= p_at and p_at < a.valid_to and a.recorded_at <= k and k < a.superseded_at
  ), rows_ as (
    select t.id, t.path from tree t
     where t.kind = 'folder' or exists (select 1 from ag where ag.node_id = t.id)
  ), own as (
    select distinct on (ag.subject_group_id, r.id) ag.subject_group_id as gid, r.id as nid, ag.level, ag.can_upload,
           ag.can_manage, ag.can_publish, ag.node_id as src
      from rows_ r join ag on ag.path @> r.path
     order by ag.subject_group_id, r.id, nlevel(ag.path) desc
  )
  select gr.id, r.id,
         (case when o.gid is null then 0
               when gr.parent_group_id is null then o.level
               when po.gid is null or not exists (select 1 from gr p where p.id = gr.parent_group_id) then 0
               else least(o.level, po.level) end)::smallint,
         coalesce(o.can_upload and (gr.parent_group_id is null or coalesce(po.can_upload, false)), false),
         coalesce(o.can_manage and (gr.parent_group_id is null or coalesce(po.can_manage, false)), false),
         coalesce(o.can_publish and (gr.parent_group_id is null or coalesce(po.can_publish, false)), false),
         o.src,
         (gr.parent_group_id is not null and o.gid is not null and o.level > coalesce(po.level, 0))
    from gr cross join rows_ r
    left join own o on o.gid = gr.id and o.nid = r.id
    left join own po on po.gid = gr.parent_group_id and po.nid = r.id;
end $$;

grant execute on function group_access_matrix(uuid, timestamptz, timestamptz) to vdrkit_app;
