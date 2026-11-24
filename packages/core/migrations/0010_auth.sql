-- SPDX-License-Identifier: AGPL-3.0-only
-- auth_* tables: no tenant_id, no RLS. Sessions resolve before the tenant is known.
-- auth_person: readable across tenants, writable only by its own

create table auth_user (
  id                  text primary key,
  name                text not null,
  email               text not null unique,
  email_verified      boolean not null default false,
  image               text,
  two_factor_enabled  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table auth_session (
  id          text primary key,
  user_id     text not null references auth_user(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index auth_session_user on auth_session (user_id);

create table auth_account (
  id                        text primary key,
  user_id                   text not null references auth_user(id) on delete cascade,
  account_id                text not null,
  provider_id               text not null,
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  password                  text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index auth_account_user on auth_account (user_id);

create table auth_verification (
  id          text primary key,
  identifier  text not null,
  value       text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index auth_verification_identifier on auth_verification (identifier);

create table auth_two_factor (
  id                         text primary key,
  user_id                    text not null references auth_user(id) on delete cascade,
  secret                     text not null,
  backup_codes               text not null,
  verified                   boolean default true,
  failed_verification_count  integer default 0,
  locked_until               timestamptz
);
create index auth_two_factor_user on auth_two_factor (user_id);

grant select, insert, update, delete on auth_user, auth_session, auth_account, auth_verification, auth_two_factor to vdrkit_app;

-- email copies person.email (person is invisible before the tenant is set); trigger keeps it in step
create table auth_person (
  tenant_id   uuid not null references tenant(id),
  person_id   uuid not null references person(id) on delete cascade,
  email       text not null,
  user_id     text references auth_user(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, person_id),
  unique (user_id, tenant_id)
);
create index auth_person_email on auth_person (lower(email));
create index auth_person_user on auth_person (user_id);

alter table auth_person enable row level security;
alter table auth_person force row level security;
create policy read_any on auth_person for select using (true);
create policy write_own_insert on auth_person for insert with check (tenant_id = current_tenant_id());
create policy write_own_update on auth_person for update
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
create policy write_own_delete on auth_person for delete using (tenant_id = current_tenant_id());
grant select, insert, update, delete on auth_person to vdrkit_app;

create or replace function auth_person_follow_person() returns trigger language plpgsql as $$
begin
  if new.erased_at is not null then
    delete from auth_person where person_id = new.id;
  elsif new.email is distinct from old.email then
    update auth_person set email = new.email, user_id = null where person_id = new.id;
  end if;
  return new;
end $$;
create trigger auth_person_follow_person after update of email, erased_at on person
  for each row execute function auth_person_follow_person();
