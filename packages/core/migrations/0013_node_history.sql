-- SPDX-License-Identifier: AGPL-3.0-only
-- same-transaction changes share a timestamp; last id wins

create table node_history (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  node_id       uuid not null,          -- no FK: outlives the node
  parent_id     uuid,
  kind          text not null,
  name          text not null,
  index_number  text,
  state         text not null,
  path          ltree not null,
  deleted_at    timestamptz,
  op            text not null check (op in ('insert', 'update', 'delete')),
  valid_from    timestamptz not null,
  valid_to      timestamptz not null default 'infinity',
  recorded_at   timestamptz not null,
  check (valid_from <= valid_to)
);
create index node_history_node on node_history (node_id, valid_from desc, id desc);
create index node_history_workspace on node_history (workspace_id, valid_from);

create function node_history_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t timestamptz := record_clock();
  r node%rowtype;
begin
  if tg_op = 'UPDATE' and (old.parent_id, old.kind, old.name, old.index_number, old.state, old.path, old.deleted_at)
       is not distinct from (new.parent_id, new.kind, new.name, new.index_number, new.state, new.path, new.deleted_at) then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select greatest(t, max(h.valid_from)) into t from node_history h where h.node_id = old.id;
    update node_history set valid_to = t where node_id = old.id and valid_to = 'infinity';
  end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  insert into node_history (tenant_id, workspace_id, node_id, parent_id, kind, name, index_number, state, path,
                            deleted_at, op, valid_from, recorded_at)
  values (r.tenant_id, r.workspace_id, r.id, r.parent_id, r.kind, r.name, r.index_number, r.state, r.path,
          case when tg_op = 'DELETE' then coalesce(r.deleted_at, t) else r.deleted_at end,
          lower(tg_op), t, t);
  return null;
end $$;

create trigger node_history_record after insert or update or delete on node
  for each row execute function node_history_record();

create function node_history_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Node history is never deleted';
  end if;
  if old.valid_to <> 'infinity' or new.valid_to < old.valid_from
     or (to_jsonb(new) - 'valid_to') <> (to_jsonb(old) - 'valid_to') then
    raise exception 'Node history is never changed';
  end if;
  return new;
end $$;
create trigger node_history_append_only before update or delete on node_history
  for each row execute function node_history_append_only();

-- recorded_at = created_at, or "as known at" finds no tree
alter table node no force row level security;
insert into node_history (tenant_id, workspace_id, node_id, parent_id, kind, name, index_number, state, path,
                          deleted_at, op, valid_from, recorded_at)
select tenant_id, workspace_id, id, parent_id, kind, name, index_number, state, path, deleted_at, 'insert', created_at, created_at
  from node;
alter table node force row level security;

alter table node_history enable row level security;
alter table node_history force row level security;
create policy tenant_isolation on node_history
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select on node_history to vdrkit_app;

create function node_at(p_node uuid, p_at timestamptz, p_known_at timestamptz default null)
returns table (node_id uuid, workspace_id uuid, parent_id uuid, kind text, name text, index_number text, state text,
               path ltree, deleted_at timestamptz)
language sql stable set search_path = public, pg_temp as $$
  select h.node_id, h.workspace_id, h.parent_id, h.kind, h.name, h.index_number, h.state, h.path, h.deleted_at
    from node_history h
   where h.node_id = p_node and h.valid_from <= p_at and h.recorded_at <= coalesce(p_known_at, p_at)
   order by h.valid_from desc, h.id desc
   limit 1
$$;

create function node_tree_at(p_workspace uuid, p_at timestamptz, p_known_at timestamptz default null)
returns table (node_id uuid, parent_id uuid, kind text, name text, index_number text, state text, path ltree)
language sql stable set search_path = public, pg_temp as $$
  select t.node_id, t.parent_id, t.kind, t.name, t.index_number, t.state, t.path
    from (select distinct on (h.node_id) h.*
            from node_history h
           where h.workspace_id = p_workspace and h.valid_from <= p_at
             and h.recorded_at <= coalesce(p_known_at, p_at)
           order by h.node_id, h.valid_from desc, h.id desc) t
   where t.deleted_at is null
$$;

create function tree_changed_since(p_workspace uuid, p_since timestamptz)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from node_history h where h.workspace_id = p_workspace and h.valid_from > p_since)
$$;

-- labels come from node_label(): 'n' + id without hyphens
create function path_ids(p ltree) returns uuid[] language sql immutable set search_path = public, pg_temp as $$
  select array_agg(substr(l, 2)::uuid order by o)
    from unnest(string_to_array(ltree2text(p), '.')) with ordinality as x(l, o)
$$;

-- tree from node_history only when it changed since p_at

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

  if not exists (
    select 1 from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = ws_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  ) then
    return query select 0::smallint, false, false, false, 'no_membership'; return;
  end if;

  select exists (
    select 1 from membership m join groups gr on gr.id = m.group_id join party pa on pa.id = gr.party_id
    where m.person_id = p_person and gr.workspace_id = ws_id and m.status = 'active'
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

  if ws.state in ('closed', 'archived') then
    upl := false;
  end if;

  if lvl = 0 and not (upl or mng or pub) then
    return query select 0::smallint, false, false, false, why; return;
  end if;
  return query select lvl, upl, mng, pub, why;
end $$;

create or replace function accessible_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean, can_publish boolean)
language plpgsql stable as $$
begin
  if not tree_changed_since(p_workspace, least(p_at, coalesce(p_known_at, p_at))) then
    return query
      select nd.id, e.level, e.can_upload, e.can_manage, e.can_publish
        from node nd cross join lateral effective_level(p_person, nd.id, p_at, p_known_at) e
       where nd.workspace_id = p_workspace and nd.deleted_at is null
         and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish);
  else
    return query
      select t.node_id, e.level, e.can_upload, e.can_manage, e.can_publish
        from node_tree_at(p_workspace, p_at, p_known_at) t
        cross join lateral effective_level(p_person, t.node_id, p_at, p_known_at) e
       where e.level > 0 or e.can_upload or e.can_manage or e.can_publish;
  end if;
end $$;

grant execute on function node_at(uuid, timestamptz, timestamptz) to vdrkit_app;
grant execute on function node_tree_at(uuid, timestamptz, timestamptz) to vdrkit_app;
grant execute on function tree_changed_since(uuid, timestamptz) to vdrkit_app;
grant execute on function path_ids(ltree) to vdrkit_app;
grant execute on function effective_level(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;
grant execute on function accessible_nodes(uuid, uuid, timestamptz, timestamptz) to vdrkit_app;
