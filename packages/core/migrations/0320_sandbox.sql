-- SPDX-License-Identifier: AGPL-3.0-only
-- sandbox marker; VDRKIT_SANDBOX=1 alone isn't enough

create table sandbox_instance (
  singleton     boolean primary key default true check (singleton),
  tenant_id     uuid not null unique references tenant(id),
  seed_version  integer not null check (seed_version > 0),
  seeded_at     timestamptz not null default now()
);

alter table sandbox_instance enable row level security;
alter table sandbox_instance force row level security;
create policy read_any on sandbox_instance for select using (true);
-- owner writes only
create policy owner_writes on sandbox_instance for all using (true) with check (true);
do $$ begin
  execute format('alter policy owner_writes on sandbox_instance to %I', current_user);
end $$;
grant select on sandbox_instance to vdrkit_app;

create function sandbox_reserved_address(p_email text) returns boolean language sql immutable
set search_path = public, pg_temp as $$
  select p_email is null
      or coalesce(lower(substring(p_email from '@([^@]+)$')) ~ '(^|\.)(example\.com|example\.net|example\.org|example|test|invalid|localhost)$', false)
$$;
grant execute on function sandbox_reserved_address(text) to vdrkit_app;

-- VS001 -> 422
create function sandbox_reserved_address_only() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.sandbox_instance) and not public.sandbox_reserved_address(new.email) then
    raise exception 'In the sandbox, every address must be at example.com, example.net or example.org, or end in .example, .test or .invalid.'
      using errcode = 'VS001';
  end if;
  return new;
end $$;
create trigger sandbox_reserved_address before insert or update of email on person
  for each row execute function sandbox_reserved_address_only();
create trigger sandbox_reserved_address before insert or update of email on auth_user
  for each row execute function sandbox_reserved_address_only();

-- counts only
create function sandbox_state() returns jsonb language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior_listing text := coalesce(current_setting('vdrkit.setup_listing', true), '');
  prior_tenant  text := coalesce(current_setting('app.tenant_id', true), '');
  marker  public.sandbox_instance%rowtype;
  site    uuid;
  t       uuid;
  tenants integer := 0;
  others  integer := 0;
  people  integer := 0;
  logins  integer := 0;
begin
  select * into marker from public.sandbox_instance;
  select tenant_id into site from public.site_instance;
  perform set_config('vdrkit.setup_listing', 'on', true);
  for t in select id from public.tenant loop
    tenants := tenants + 1;
    if marker.tenant_id is null or t <> marker.tenant_id then others := others + 1; end if;
    perform set_config('app.tenant_id', t::text, true);
    people := people + (select count(*) from public.person p where p.tenant_id = t and not public.sandbox_reserved_address(p.email));
  end loop;
  perform set_config('vdrkit.setup_listing', prior_listing, true);
  perform set_config('app.tenant_id', prior_tenant, true);
  select count(*) into logins from public.auth_user u where not public.sandbox_reserved_address(u.email);
  return jsonb_build_object(
    'marker_tenant', marker.tenant_id, 'seed_version', marker.seed_version, 'seeded_at', marker.seeded_at,
    'site_tenant', site, 'tenants', tenants, 'other_tenants', others, 'outside_people', people, 'outside_logins', logins);
end $$;

revoke all on function sandbox_state() from public;
grant execute on function sandbox_state() to vdrkit_app;
