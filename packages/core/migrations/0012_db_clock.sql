-- SPDX-License-Identifier: AGPL-3.0-only
-- Record times from the database clock
-- state tables: now(), so supersede + insert in one transaction leave no gap
-- events: clock_timestamp() under the chain lock, so time follows chain order
-- tests replace db_clock_pin() as owner; the app role cannot

create function db_clock_pin() returns timestamptz language sql stable as $$
  select null::timestamptz
$$;

create function record_clock() returns timestamptz language sql stable as $$
  select coalesce(db_clock_pin(), now())
$$;

create function event_clock() returns timestamptz language sql volatile as $$
  select coalesce(db_clock_pin(), clock_timestamp())
$$;

create function stamp_record_time() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_at := record_clock();
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
    new.superseded_at := record_clock();
  end if;
  return new;
end $$;

-- a_ prefix: must fire before access_grant_append_only
create trigger a_record_time before insert or update on access_grant
  for each row execute function stamp_record_time();
create trigger a_record_time before insert or update on membership
  for each row execute function stamp_record_time();

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'access_grant'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%recorded_at < superseded_at%';
  if c is not null then
    execute format('alter table access_grant drop constraint %I', c);
  end if;
end $$;
alter table access_grant add constraint access_grant_record_period check (recorded_at <= superseded_at);

create function stamp_created_at() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := record_clock();
  elsif new.created_at is distinct from old.created_at then
    raise exception 'created_at is set by the database and never changes' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger a_record_time before insert or update on document_version
  for each row execute function stamp_created_at();

-- occurred_at is hashed; set here, p_occurred_at ignored

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
  t     uuid := current_tenant_id();
  ck    uuid;
  c     event_chain%rowtype;
  e     event;
  last  timestamptz;
begin
  if t is null then
    raise exception 'No tenant set for this transaction';
  end if;
  ck := coalesce(p_workspace_id, t);

  insert into event_counter (tenant_id) values (t) on conflict do nothing;
  update event_counter set last_seq = last_seq + 1 where tenant_id = t returning last_seq into e.seq;

  insert into event_chain (tenant_id, chain_key) values (t, ck) on conflict do nothing;
  select * into c from event_chain where chain_key = ck for update;

  -- never before the previous link, even if the clock steps back
  select ev.occurred_at into last from event ev where ev.chain_key = ck and ev.chain_pos = c.length;

  e.id := gen_random_uuid();
  e.tenant_id := t;
  e.chain_key := ck;
  e.chain_pos := c.length + 1;
  e.occurred_at := greatest(event_clock(), last);
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

revoke insert on event from vdrkit_app;
revoke all on function append_event(text, uuid, uuid, uuid, text, uuid, jsonb, text, timestamptz) from public;
grant execute on function append_event(text, uuid, uuid, uuid, text, uuid, jsonb, text, timestamptz) to vdrkit_app;
grant execute on function db_clock_pin() to vdrkit_app;
grant execute on function record_clock() to vdrkit_app;
grant execute on function event_clock() to vdrkit_app;
