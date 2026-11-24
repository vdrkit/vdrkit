-- SPDX-License-Identifier: AGPL-3.0-only

alter table node add column published_at timestamptz;
alter table node add column published_by uuid references person(id);
alter table node add column withdrawn_at timestamptz;

alter table document_version add column processing_status text not null default 'pending'
  check (processing_status in ('pending', 'processing', 'ready', 'failed'));
alter table document_version add column processing_error text;
alter table document_version add column failed_step text;
alter table document_version add column page_count integer;

-- ignores draft state and person denies; inheritance and subgroup rules must match effective_level()
create or replace function group_level(p_group uuid, p_node uuid, p_at timestamptz default now())
returns smallint language plpgsql stable as $$
declare
  n node%rowtype;
  g groups%rowtype;
  own smallint;
  parent smallint;
begin
  select * into n from node where id = p_node;
  select * into g from groups where id = p_group;
  if n.id is null or g.id is null or not (g.valid_from <= p_at and p_at < g.valid_to) then
    return 0;
  end if;
  select ag.level into own from access_grant ag join node a on a.id = ag.node_id
   where ag.subject_group_id = p_group and ag.effect = 'allow' and a.path @> n.path
     and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= p_at and p_at < ag.superseded_at
   order by nlevel(a.path) desc limit 1;
  if own is null then return 0; end if;
  if g.parent_group_id is not null then
    parent := group_level(g.parent_group_id, p_node, p_at);
    return least(own, parent);
  end if;
  return own;
end $$;

grant execute on function group_level(uuid, uuid, timestamptz) to vdrkit_app;
