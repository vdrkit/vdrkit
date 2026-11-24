#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Runs once on an empty volume. Never give vdrkit_app superuser or BYPASSRLS: RLS would be skipped.
#   vdrkit_owner  migrations (MIGRATION_DATABASE_URL)
#   vdrkit_app    API and worker (DATABASE_URL)
#   vdrkit_queue  pg-boss (QUEUE_DATABASE_URL)
set -eu

for v in POSTGRES_PASSWORD VDRKIT_OWNER_PASSWORD VDRKIT_APP_PASSWORD VDRKIT_QUEUE_PASSWORD; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then echo "01-roles.sh: $v is empty. Set it in .env, remove the pg_data volume and start again." >&2; exit 1; fi
  case "$val" in
    CHANGE_ME*) echo "01-roles.sh: $v is still the CHANGE_ME placeholder. Set it in .env (openssl rand -hex 32), remove the pg_data volume and start again." >&2; exit 1 ;;
  esac
done

psql -v ON_ERROR_STOP=1 --username postgres --dbname "$POSTGRES_DB" \
  -v owner_pw="$VDRKIT_OWNER_PASSWORD" -v app_pw="$VDRKIT_APP_PASSWORD" -v queue_pw="$VDRKIT_QUEUE_PASSWORD" <<'SQL'
create role vdrkit_owner login nosuperuser nobypassrls nocreaterole nocreatedb password :'owner_pw';
create role vdrkit_app   login nosuperuser nobypassrls nocreaterole nocreatedb password :'app_pw';
create role vdrkit_queue login nosuperuser nobypassrls nocreaterole nocreatedb password :'queue_pw';

alter database :"DBNAME" owner to vdrkit_owner;
alter schema public owner to vdrkit_owner;
revoke create on schema public from public;
revoke create on database :"DBNAME" from public;
grant connect on database :"DBNAME" to vdrkit_app, vdrkit_queue;
-- pg-boss creates its own schema on first start.
grant create on database :"DBNAME" to vdrkit_queue;

-- ltree is a trusted extension, but creating it here keeps the migrations free of any superuser step.
create extension if not exists ltree;
SQL
