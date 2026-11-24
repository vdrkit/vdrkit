-- SPDX-License-Identifier: AGPL-3.0-only
alter table index_renumber_seen add column knew boolean not null default true;
comment on column index_renumber_seen.knew is
  'Whether the person could read the folder or document when it was renumbered. Only then do they see "Renumbered": someone who never saw the old number has nothing to relearn.';

-- insert even when knew is false, so it's checked once
create or replace function mark_renumbers_seen(p_person uuid, p_workspace uuid) returns void
language sql volatile set search_path = public, pg_temp as $$
  with fresh as materialized (
    select r.id, r.tenant_id, r.workspace_id, r.node_id, r.renumbered_at
      from index_renumber r
     where r.workspace_id = p_workspace
       and r.renumbered_at > (select min(m.recorded_at) from membership m join groups g on g.id = m.group_id
                               where m.person_id = p_person and g.workspace_id = p_workspace)
       and not exists (select 1 from index_renumber_seen s where s.person_id = p_person and s.renumber_id = r.id)
  ), moments as (
    select distinct renumbered_at from fresh
  ), knew as materialized (
    select m.renumbered_at, a.node_id
      from moments m cross join lateral readable_nodes(p_person, p_workspace, m.renumbered_at, null, false) a
     where a.level > 0 or a.can_upload or a.can_manage or a.can_publish
  )
  insert into index_renumber_seen (tenant_id, workspace_id, person_id, renumber_id, first_seen_at, knew)
  select f.tenant_id, f.workspace_id, p_person, f.id, record_clock(),
         exists (select 1 from knew k where k.renumbered_at = f.renumbered_at and k.node_id = f.node_id)
    from fresh f
  on conflict do nothing
$$;

create or replace function renumbered_tags(p_person uuid, p_workspace uuid)
returns table (node_id uuid, from_number text)
language sql stable set search_path = public, pg_temp as $$
  select t.node_id, t.from_number
    from (select distinct on (r.node_id) r.node_id, r.from_number
            from index_renumber r
            join index_renumber_seen s on s.renumber_id = r.id and s.person_id = p_person and s.knew
            join workspace w on w.id = r.workspace_id
           where r.workspace_id = p_workspace
             and s.first_seen_at + make_interval(days => w.renumbered_tag_days) > record_clock()
           order by r.node_id, r.renumbered_at, r.id) t
    join node n on n.id = t.node_id
   where n.deleted_at is null and n.index_number is distinct from t.from_number
$$;
