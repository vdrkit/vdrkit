-- SPDX-License-Identifier: AGPL-3.0-only
-- per login, not tenant: no RLS
-- sign-in layer's clock, not record_clock()

alter table workspace
  add column require_two_factor     boolean  not null default true,
  add column allow_trusted_browser  boolean  not null default true,
  add column trusted_browser_days   smallint not null default 30
    constraint workspace_trusted_browser_days check (trusted_browser_days between 1 and 90),
  add column idle_sign_out_minutes  smallint not null default 240
    constraint workspace_idle_sign_out_minutes check (idle_sign_out_minutes in (30, 60, 120, 240, 480, 1440));

-- grace period for in-flight requests
alter table auth_session
  add column last_active_at   timestamptz,
  add column token_issued_at  timestamptz,
  add column rotated_at       timestamptz,
  add column rotated_to       text;

create table auth_trusted_browser (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null references auth_user(id) on delete cascade,
  -- follows Better Auth, which replaces the row on every use
  trust_identifier  text not null unique,
  user_agent        text,
  created_at        timestamptz not null,
  -- fixed at trust time
  trusted_until     timestamptz not null,
  last_used_at      timestamptz,
  constraint auth_trusted_browser_period check (trusted_until > created_at)
);
create index auth_trusted_browser_user on auth_trusted_browser (user_id);

grant select, insert, update, delete on auth_trusted_browser to vdrkit_app;
