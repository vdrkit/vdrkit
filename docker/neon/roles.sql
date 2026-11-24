-- SPDX-License-Identifier: AGPL-3.0-only
-- Neon / managed Postgres without a superuser. Run once on the direct (non-pooler) connection:
--   owner_pw=$(openssl rand -hex 24); app_pw=$(openssl rand -hex 24); queue_pw=$(openssl rand -hex 24)
--   printf 'vdrkit_owner %s\nvdrkit_app %s\nvdrkit_queue %s\n' "$owner_pw" "$app_pw" "$queue_pw"
--   psql "postgresql://neondb_owner:...@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require" \
--     -v owner_pw="$owner_pw" -v app_pw="$app_pw" -v queue_pw="$queue_pw" -f docker/neon/roles.sql
-- save the printed passwords first; shown nowhere else
-- not the console: its roles join neon_superuser and would bypass RLS
\set ON_ERROR_STOP on

create role vdrkit_owner login nosuperuser nobypassrls nocreaterole nocreatedb password :'owner_pw';
create role vdrkit_app   login nosuperuser nobypassrls nocreaterole nocreatedb password :'app_pw';
create role vdrkit_queue login nosuperuser nobypassrls nocreaterole nocreatedb password :'queue_pw';

-- PG16+: needed to hand the database to vdrkit_owner
grant vdrkit_owner to current_user;
create database vdrkit owner vdrkit_owner;

\connect vdrkit
-- trusted extension; keeps migrations free of extra rights
create extension if not exists ltree;

set role vdrkit_owner;
revoke create on schema public from public;
revoke create on database vdrkit from public;
grant connect on database vdrkit to vdrkit_app, vdrkit_queue;
grant create on database vdrkit to vdrkit_queue;
reset role;

select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
  from pg_roles where rolname in ('vdrkit_owner', 'vdrkit_app', 'vdrkit_queue') order by rolname;
