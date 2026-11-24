-- SPDX-License-Identifier: AGPL-3.0-only
-- Core schema

create extension if not exists ltree;

-- never bypasses RLS
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'vdrkit_app') then
    create role vdrkit_app nologin;
  end if;
end $$;

create or replace function current_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create table tenant (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  data_region  text not null default 'local',
  key_ref      text,                                  -- not the key itself
  created_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);

-- erasable; nothing here is hashed
create table person (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  email       text not null,
  time_zone   text not null default 'UTC',
  locale      text not null default 'en-GB',
  erased_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (tenant_id, email)
);

create table principal (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenant(id),
  kind                    text not null check (kind in ('person', 'api_key', 'service', 'agent')),
  person_id               uuid references person(id),
  on_behalf_of_person_id  uuid references person(id),
  max_level               smallint check (max_level in (0, 10, 20, 30, 40, 50, 60)),
  name                    text not null,
  created_at              timestamptz not null default now(),
  revoked_at              timestamptz,
  metadata                jsonb not null default '{}',
  check (kind <> 'person' or person_id is not null),
  check (kind <> 'agent' or on_behalf_of_person_id is not null)
);

create table workspace (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  type          text not null default 'deal_room' check (type in ('deal_room', 'clean_room', 'board')),
  state         text not null default 'draft' check (state in ('draft', 'active', 'closed', 'archived', 'deleted')),
  name          text not null,
  time_zone     text not null default 'UTC',
  modules       text[] not null default '{}',
  requires_nda  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'
);

create table party (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  name          text not null,
  kind          text not null check (kind in ('seller', 'bidder', 'financier', 'observer', 'other')),
  created_at    timestamptz not null default now(),
  metadata      jsonb not null default '{}'
);

create table groups (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  workspace_id     uuid not null references workspace(id),
  party_id         uuid not null references party(id),
  parent_group_id  uuid references groups(id),
  name             text not null,
  role_template    text not null default 'member',
  valid_from       timestamptz not null default '-infinity',
  valid_to         timestamptz not null default 'infinity',
  created_at       timestamptz not null default now(),
  metadata         jsonb not null default '{}'
);

create or replace function groups_one_level() returns trigger language plpgsql as $$
begin
  if new.parent_group_id is not null and exists (
    select 1 from groups g where g.id = new.parent_group_id and g.parent_group_id is not null
  ) then
    raise exception 'A subgroup cannot have its own subgroups' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger groups_one_level before insert or update on groups for each row execute function groups_one_level();

create table membership (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  person_id      uuid not null references person(id),
  group_id       uuid not null references groups(id),
  role           text not null default 'member',
  status         text not null default 'active' check (status in ('requested', 'approved', 'active', 'revoked')),
  valid_from     timestamptz not null default '-infinity',
  valid_to       timestamptz not null default 'infinity',
  recorded_at    timestamptz not null default now(),
  superseded_at  timestamptz not null default 'infinity',
  metadata       jsonb not null default '{}'
);
create index membership_person on membership (person_id) where superseded_at = 'infinity';

create table node (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  workspace_id     uuid not null references workspace(id),
  parent_id        uuid references node(id),
  kind             text not null check (kind in ('folder', 'document')),
  name             text not null,
  index_number     text,
  sort_key         integer not null default 0,
  path             ltree not null,
  state            text not null default 'draft' check (state in ('draft', 'published', 'withdrawn')),
  owning_party_id  uuid references party(id),
  external_ref     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  metadata         jsonb not null default '{}'
);
create index node_path on node using gist (path);
create index node_parent on node (parent_id);

create or replace function node_label(p_id uuid) returns text language sql immutable as $$
  select 'n' || replace(p_id::text, '-', '')
$$;

create or replace function node_path_maintain() returns trigger language plpgsql as $$
declare
  parent_path ltree;
  old_path ltree;
begin
  if new.parent_id is null then
    new.path := text2ltree(node_label(new.id));
  else
    select path into parent_path from node where id = new.parent_id;
    if parent_path is null then
      raise exception 'Parent node % not found', new.parent_id;
    end if;
    if tg_op = 'UPDATE' and parent_path <@ old.path then
      raise exception 'A folder cannot move inside itself';
    end if;
    new.path := parent_path || text2ltree(node_label(new.id));
  end if;
  if tg_op = 'UPDATE' and new.path is distinct from old.path then
    old_path := old.path;
    update node set path = new.path || subpath(path, nlevel(old_path))
      where path <@ old_path and id <> new.id;
  end if;
  return new;
end $$;
create trigger node_path_insert before insert on node for each row execute function node_path_maintain();
create trigger node_path_update before update of parent_id on node for each row execute function node_path_maintain();

create table document_version (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  node_id      uuid not null references node(id),
  version_no   integer not null,
  storage_key  text not null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   bigint not null,
  mime         text not null,
  uploaded_by  uuid references principal(id),
  visible_to_group_ids uuid[] not null default '{}',   -- empty = all groups with access
  created_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}',
  unique (node_id, version_no)
);
create index document_version_sha on document_version (tenant_id, sha256);

create table derived_file (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  version_id   uuid not null references document_version(id),
  kind         text not null,
  step         text not null,
  storage_key  text not null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);

create table agreement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  kind          text not null check (kind in ('nda', 'clean_team', 'other')),
  name          text not null,
  created_at    timestamptz not null default now()
);

create table agreement_version (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  agreement_id  uuid not null references agreement(id),
  version_no    integer not null,
  body          text not null,
  published_at  timestamptz not null,
  unique (agreement_id, version_no)
);

create table acceptance (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id),
  agreement_version_id  uuid not null references agreement_version(id),
  person_id             uuid not null references person(id),
  accepted_at           timestamptz not null,
  unique (agreement_version_id, person_id)
);

create table access_grant (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id),
  workspace_id       uuid not null references workspace(id),
  node_id            uuid not null references node(id),
  subject_group_id   uuid references groups(id),
  subject_person_id  uuid references person(id),
  effect             text not null default 'allow' check (effect in ('allow', 'deny')),
  level              smallint not null default 0 check (level in (0, 10, 20, 30, 40, 50, 60)),
  can_upload         boolean not null default false,
  can_manage         boolean not null default false,
  valid_from         timestamptz not null default '-infinity',
  valid_to           timestamptz not null default 'infinity',
  recorded_at        timestamptz not null default now(),
  superseded_at      timestamptz not null default 'infinity',
  recorded_by        uuid references principal(id),
  check ((subject_group_id is null) <> (subject_person_id is null)),
  check (effect = 'allow' or subject_person_id is not null),
  check (valid_from < valid_to),
  check (recorded_at < superseded_at)
);
create unique index access_grant_current on access_grant
  (node_id, coalesce(subject_group_id, subject_person_id), effect) where superseded_at = 'infinity';
create index access_grant_lookup on access_grant (node_id, subject_group_id);

create or replace function access_grant_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Grants are never deleted. Supersede them instead.';
  end if;
  if old.superseded_at <> 'infinity'
     or (to_jsonb(new) - 'superseded_at') <> (to_jsonb(old) - 'superseded_at') then
    raise exception 'Grants are never changed. Supersede them and insert a new row.';
  end if;
  return new;
end $$;
create trigger access_grant_append_only before update or delete on access_grant
  for each row execute function access_grant_append_only();

-- information barriers hook, no-op

create or replace function barrier_cap(p_person uuid, p_node uuid, p_level smallint, p_at timestamptz)
returns smallint language sql stable as $$
  select p_level
$$;

-- p_at = valid time, p_known_at = record time (defaults to p_at)

create or replace function effective_level(
  p_person    uuid,
  p_node      uuid,
  p_at        timestamptz default now(),
  p_known_at  timestamptz default null
) returns table (level smallint, can_upload boolean, can_manage boolean, reason text)
language plpgsql stable as $$
declare
  k         timestamptz := coalesce(p_known_at, p_at);
  n         node%rowtype;
  ws        workspace%rowtype;
  lvl       smallint := 0;
  upl       boolean := false;
  mng       boolean := false;
  why       text := 'no_grant';
  is_seller boolean;
  g         record;
  gl        record;
  pl        record;
  r         record;
begin
  select * into n from node where id = p_node and deleted_at is null;
  if not found then
    return query select 0::smallint, false, false, 'node_not_found'; return;
  end if;
  select * into ws from workspace where id = n.workspace_id;
  if ws.state = 'deleted' then
    return query select 0::smallint, false, false, 'workspace_deleted'; return;
  end if;

  if not exists (
    select 1 from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = n.workspace_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  ) then
    return query select 0::smallint, false, false, 'no_membership'; return;
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
      return query select 0::smallint, false, false, 'nda_not_accepted'; return;
    end if;
  end if;

  select ag.id into r from access_grant ag join node a on a.id = ag.node_id
  where ag.subject_person_id = p_person and ag.effect = 'deny' and a.path @> n.path
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  limit 1;
  if found then
    return query select 0::smallint, false, false, 'deny:' || r.id; return;
  end if;

  for g in
    select distinct gr.id, gr.parent_group_id from membership m join groups gr on gr.id = m.group_id
    where m.person_id = p_person and gr.workspace_id = n.workspace_id and m.status = 'active'
      and m.valid_from <= p_at and p_at < m.valid_to and m.recorded_at <= k and k < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to
  loop
    select ag.id, ag.level, ag.can_upload, ag.can_manage into gl
    from access_grant ag join node a on a.id = ag.node_id
    where ag.subject_group_id = g.id and ag.effect = 'allow' and a.path @> n.path
      and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
    order by nlevel(a.path) desc limit 1;
    continue when not found;

    if g.parent_group_id is not null then
      if not exists (select 1 from groups pg where pg.id = g.parent_group_id and pg.valid_from <= p_at and p_at < pg.valid_to) then
        continue;
      end if;
      select ag.level, ag.can_upload, ag.can_manage into pl
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
    end if;

    if gl.level > lvl or (gl.level = lvl and why = 'no_grant') then
      lvl := gl.level; why := 'grant:' || gl.id;
    end if;
    upl := upl or gl.can_upload;
    mng := mng or gl.can_manage;
  end loop;

  select ag.id, ag.level, ag.can_upload, ag.can_manage into gl
  from access_grant ag join node a on a.id = ag.node_id
  where ag.subject_person_id = p_person and ag.effect = 'allow' and a.path @> n.path
    and ag.valid_from <= p_at and p_at < ag.valid_to and ag.recorded_at <= k and k < ag.superseded_at
  order by nlevel(a.path) desc limit 1;
  if found then
    if gl.level > lvl then lvl := gl.level; why := 'grant:' || gl.id; end if;
    upl := upl or gl.can_upload;
    mng := mng or gl.can_manage;
  end if;

  if exists (select 1 from node a where a.path @> n.path and a.state in ('draft', 'withdrawn')) and not (mng or upl) then
    return query select 0::smallint, false, false, 'not_published'; return;
  end if;

  lvl := barrier_cap(p_person, p_node, lvl, p_at);

  if ws.state in ('closed', 'archived') then
    upl := false;
  end if;

  if lvl = 0 and not (upl or mng) then
    return query select 0::smallint, false, false, why; return;
  end if;
  return query select lvl, upl, mng, why;
end $$;

create or replace function is_workspace_admin(p_person uuid, p_workspace uuid, p_at timestamptz default now())
returns boolean language sql stable as $$
  select exists (
    select 1 from membership m join groups gr on gr.id = m.group_id join party pa on pa.id = gr.party_id
    where m.person_id = p_person and gr.workspace_id = p_workspace and gr.role_template = 'admin' and pa.kind = 'seller'
      and m.status = 'active' and m.valid_from <= p_at and p_at < m.valid_to
      and m.recorded_at <= p_at and p_at < m.superseded_at
      and gr.valid_from <= p_at and p_at < gr.valid_to)
$$;

-- listings go through effective_level(): never show what a single check refuses
create or replace function accessible_nodes(
  p_person uuid, p_workspace uuid, p_at timestamptz default now(), p_known_at timestamptz default null
) returns table (node_id uuid, level smallint, can_upload boolean, can_manage boolean)
language sql stable as $$
  select nd.id, e.level, e.can_upload, e.can_manage
  from node nd cross join lateral effective_level(p_person, nd.id, p_at, p_known_at) e
  where nd.workspace_id = p_workspace and nd.deleted_at is null and (e.level > 0 or e.can_upload or e.can_manage)
$$;

create table event_counter (
  tenant_id  uuid primary key references tenant(id),
  last_seq   bigint not null default 0
);

create table event_chain (
  tenant_id   uuid not null references tenant(id),
  chain_key   uuid primary key,
  length      bigint not null default 0,
  head_hash   text not null default repeat('0', 64)
);

create table event (
  id               uuid not null default gen_random_uuid(),
  tenant_id        uuid not null,
  seq              bigint not null,
  chain_key        uuid not null,
  chain_pos        bigint not null,
  occurred_at      timestamptz not null,
  workspace_id     uuid,
  actor_id         uuid,
  on_behalf_of_id  uuid,
  action           text not null,
  resource_type    text,
  resource_id      uuid,
  data             jsonb not null default '{}',   -- ids and values only, never names or emails
  request_id       text,
  prev_hash        text not null,
  hash             text not null,
  primary key (occurred_at, id)
) partition by range (occurred_at);
create index event_seq on event (tenant_id, seq);
create index event_chain_pos on event (chain_key, chain_pos);
create index event_resource on event (resource_id);
create table event_default partition of event default;

-- partitions don't inherit the parent's RLS policy
create or replace function secure_event_partition(p_name text) returns void language plpgsql as $$
begin
  execute format('alter table %I enable row level security', p_name);
  execute format('alter table %I force row level security', p_name);
  if not exists (select 1 from pg_policies where tablename = p_name and policyname = 'tenant_isolation') then
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', p_name);
  end if;
  if exists (select 1 from pg_roles where rolname = 'vdrkit_app') then
    execute format('revoke all on %I from vdrkit_app', p_name);
  end if;
end $$;

-- IP, user agent: outside the hash
create table event_context (
  event_id     uuid not null,
  occurred_at  timestamptz not null,
  tenant_id    uuid not null,
  ip           inet,
  user_agent   text,
  primary key (event_id)
);

create or replace function ensure_event_partition(p_month date) returns text language plpgsql as $$
declare
  start_d date := date_trunc('month', p_month)::date;
  name text := 'event_' || to_char(start_d, 'YYYY_MM');
begin
  if not exists (select 1 from pg_class where relname = name) then
    execute format('create table %I partition of event for values from (%L) to (%L)',
                   name, start_d, (start_d + interval '1 month')::date);
    perform secure_event_partition(name);
  end if;
  return name;
end $$;

-- changing this breaks every chain; bump v1
create or replace function event_canonical(e event) returns text language sql immutable as $$
  select 'v1|' || jsonb_build_object(
    'id', e.id, 'tenant_id', e.tenant_id, 'seq', e.seq, 'chain_key', e.chain_key, 'chain_pos', e.chain_pos,
    'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'workspace_id', e.workspace_id, 'actor_id', e.actor_id, 'on_behalf_of_id', e.on_behalf_of_id,
    'action', e.action, 'resource_type', e.resource_type, 'resource_id', e.resource_id,
    'data', e.data, 'request_id', e.request_id)::text
$$;

create or replace function event_hash(prev_hash text, e event) returns text language sql immutable as $$
  select encode(sha256(convert_to(prev_hash || '|' || event_canonical(e), 'UTF8')), 'hex')
$$;

-- call inside the work's transaction: the action must not commit without its event
create or replace function append_event(
  p_action          text,
  p_workspace_id    uuid default null,
  p_actor_id        uuid default null,
  p_on_behalf_of_id uuid default null,
  p_resource_type   text default null,
  p_resource_id     uuid default null,
  p_data            jsonb default '{}',
  p_request_id      text default null,
  p_occurred_at     timestamptz default now()
) returns event language plpgsql as $$
declare
  t   uuid := current_tenant_id();
  ck  uuid;
  c   event_chain%rowtype;
  e   event;
begin
  if t is null then
    raise exception 'No tenant set for this transaction';
  end if;
  ck := coalesce(p_workspace_id, t);

  insert into event_counter (tenant_id) values (t) on conflict do nothing;
  update event_counter set last_seq = last_seq + 1 where tenant_id = t returning last_seq into e.seq;

  insert into event_chain (tenant_id, chain_key) values (t, ck) on conflict do nothing;
  select * into c from event_chain where chain_key = ck for update;

  e.id := gen_random_uuid();
  e.tenant_id := t;
  e.chain_key := ck;
  e.chain_pos := c.length + 1;
  e.occurred_at := p_occurred_at;
  e.workspace_id := p_workspace_id;
  e.actor_id := p_actor_id;
  e.on_behalf_of_id := p_on_behalf_of_id;
  e.action := p_action;
  e.resource_type := p_resource_type;
  e.resource_id := p_resource_id;
  e.data := coalesce(p_data, '{}');
  e.request_id := p_request_id;
  e.prev_hash := c.head_hash;
  e.hash := event_hash(c.head_hash, e);

  insert into event select e.*;
  update event_chain set length = e.chain_pos, head_hash = e.hash where chain_key = ck;
  return e;
end $$;

create or replace function verify_chain(p_chain_key uuid)
returns table (checked bigint, first_broken bigint) language plpgsql stable as $$
declare
  prev text := repeat('0', 64);
  pos  bigint := 0;
  e    event;
begin
  for e in select * from event where chain_key = p_chain_key order by chain_pos loop
    pos := pos + 1;
    if e.chain_pos <> pos or e.prev_hash <> prev or e.hash <> event_hash(prev, e) then
      return query select pos, pos; return;
    end if;
    prev := e.hash;
  end loop;
  if exists (select 1 from event_chain ch where ch.chain_key = p_chain_key and (ch.length <> pos or ch.head_hash <> prev)) then
    return query select pos, pos + 1; return;
  end if;
  return query select pos, null::bigint;
end $$;

create or replace function event_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'The event log is append-only';
end $$;
create trigger event_append_only before update or delete on event
  for each row execute function event_append_only();

do $$
declare t text;
begin
  for t in select unnest(array[
    'person', 'principal', 'workspace', 'party', 'groups', 'membership', 'node', 'document_version',
    'derived_file', 'agreement', 'agreement_version', 'acceptance', 'access_grant',
    'event_counter', 'event_chain', 'event', 'event_context'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
  end loop;
end $$;

alter table tenant enable row level security;
alter table tenant force row level security;
create policy tenant_isolation on tenant using (id = current_tenant_id()) with check (id = current_tenant_id());

grant usage on schema public to vdrkit_app;
grant select, insert, update on all tables in schema public to vdrkit_app;
grant delete on person, event_context to vdrkit_app;   -- erasure only; memberships are never deleted
revoke update on event from vdrkit_app;
select secure_event_partition('event_default');
grant execute on all functions in schema public to vdrkit_app;
