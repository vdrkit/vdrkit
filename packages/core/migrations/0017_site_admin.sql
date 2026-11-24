-- SPDX-License-Identifier: AGPL-3.0-only

-- no access to room content
alter table person add column is_site_admin boolean not null default false;
alter table person add column disabled_at timestamptz;
alter table person add column disabled_by uuid references person(id);

create function stamp_person_disabled() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if new.disabled_at is not null and (tg_op = 'INSERT' or old.disabled_at is null) then
    new.disabled_at := public.record_clock();
  elsif tg_op = 'UPDATE' and new.disabled_at is not null and old.disabled_at is not null then
    new.disabled_at := old.disabled_at;   -- keep the first
  end if;
  return new;
end $$;
create trigger a_disabled_time before insert or update of disabled_at on person
  for each row execute function stamp_person_disabled();

create or replace function auth_person_follow_disabled() returns trigger language plpgsql as $$
begin
  if new.disabled_at is not null and old.disabled_at is null then
    delete from auth_person where person_id = new.id;
  end if;
  return new;
end $$;
create trigger auth_person_follow_disabled after update of disabled_at on person
  for each row execute function auth_person_follow_disabled();

-- constant PK: only one setup can win
create table site_instance (
  singleton           boolean primary key default true check (singleton),
  tenant_id           uuid not null unique references tenant(id),
  setup_completed_at  timestamptz not null
);

create function stamp_setup_completed() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  new.setup_completed_at := public.record_clock();
  return new;
end $$;
create trigger a_record_time before insert on site_instance for each row execute function stamp_setup_completed();

alter table site_instance enable row level security;
alter table site_instance force row level security;
create policy read_any on site_instance for select using (true);
create policy write_own on site_instance for insert with check (tenant_id = current_tenant_id());
grant select, insert on site_instance to vdrkit_app;

create table site_settings (
  tenant_id             uuid primary key references tenant(id),
  org_name              text,
  org_domain            text check (org_domain is null or org_domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'),
  logo_light            jsonb,
  logo_dark             jsonb,
  mail_host             text,
  mail_port             integer check (mail_port between 1 and 65535),
  mail_security         text check (mail_security in ('starttls', 'tls')),
  mail_user             text,
  -- wrapped, tenant-bound, never returned
  mail_password_wrapped jsonb,
  mail_from_address     text,
  mail_from_name        text,
  dkim_selector         text not null default 'default' check (dkim_selector ~ '^[A-Za-z0-9._-]{1,63}$'),
  room_creation         text not null default 'listed' check (room_creation in ('site_admins', 'listed', 'domain')),
  alert_admins          boolean not null default true,
  alert_extra_email     text,
  alert_after_minutes   integer not null default 15 check (alert_after_minutes in (5, 15, 60)),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references person(id),
  check (mail_host is null or (mail_port is not null and mail_security is not null and mail_from_address is not null))
);

create function stamp_site_settings() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  new.updated_at := public.record_clock();
  return new;
end $$;
create trigger a_record_time before insert or update on site_settings for each row execute function stamp_site_settings();

create table site_health_state (
  tenant_id        uuid not null references tenant(id),
  check_key        text not null check (check_key ~ '^[a-z_]{2,40}$'),
  status           text not null check (status in ('ok', 'warning', 'failing', 'not_checked')),
  detail           text,
  failing_since    timestamptz,
  alerted_at       timestamptz,
  last_checked_at  timestamptz not null,
  primary key (tenant_id, check_key)
);

do $$
declare t text;
begin
  foreach t in array array['site_settings', 'site_health_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;

create function person_can_create_rooms(p_person uuid) returns boolean language sql stable
set search_path = public, pg_temp as $$
  select coalesce((
    select p.disabled_at is null and p.erased_at is null and (
             p.is_site_admin
             or case coalesce(s.room_creation, 'listed')
                  when 'listed' then p.can_create_rooms
                  when 'domain' then s.org_domain is not null and lower(split_part(p.email, '@', 2)) = s.org_domain
                  else false end)
      from public.person p left join public.site_settings s on s.tenant_id = p.tenant_id
     where p.id = p_person), false)
$$;
grant execute on function person_can_create_rooms(uuid) to vdrkit_app;

create policy setup_listing on tenant for select
  using (current_setting('vdrkit.setup_listing', true) = 'on');
do $$ begin
  execute format('alter policy setup_listing on tenant to %I', current_user);
end $$;

create function site_setup_open() returns boolean language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.setup_listing', true), '');
  open boolean;
begin
  perform set_config('vdrkit.setup_listing', 'on', true);
  select not exists (select 1 from public.tenant)
     and not exists (select 1 from public.auth_user)
     and not exists (select 1 from public.site_instance)
    into open;
  perform set_config('vdrkit.setup_listing', prior, true);
  return open;
end $$;

revoke all on function site_setup_open() from public;
grant execute on function site_setup_open() to vdrkit_app;

-- an install that already has a tenant never runs setup: name a lone tenant as the site

do $$
declare
  tenants uuid[];
begin
  perform set_config('vdrkit.setup_listing', 'on', true);
  select coalesce(array_agg(id), '{}') into tenants from public.tenant;
  perform set_config('vdrkit.setup_listing', '', true);
  if cardinality(tenants) = 1 then
    perform set_config('app.tenant_id', tenants[1]::text, true);
    insert into site_instance (tenant_id) values (tenants[1]);
    perform set_config('app.tenant_id', '', true);
  end if;
end $$;
