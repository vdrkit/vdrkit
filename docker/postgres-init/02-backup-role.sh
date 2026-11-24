#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# vdrkit_backup, read-only. Existing install: set VDRKIT_BACKUP_PASSWORD, up -d postgres, then
#   docker compose exec postgres sh /docker-entrypoint-initdb.d/02-backup-role.sh
# BYPASSRLS or pg_dump refuses the forced-RLS tables. Treat the password like the database.
set -eu

if [ -z "${VDRKIT_BACKUP_PASSWORD:-}" ]; then
  echo "02-backup-role.sh: VDRKIT_BACKUP_PASSWORD is empty, so no backup role is created. Set it in .env to use the backup service."
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username postgres --dbname "${POSTGRES_DB:-vdrkit}" -v backup_pw="$VDRKIT_BACKUP_PASSWORD" <<'SQL'
select not exists (select 1 from pg_roles where rolname = 'vdrkit_backup') as missing \gset
\if :missing
  create role vdrkit_backup login nosuperuser bypassrls nocreaterole nocreatedb;
\endif
alter role vdrkit_backup with login nosuperuser bypassrls nocreaterole nocreatedb password :'backup_pw';
grant pg_read_all_data to vdrkit_backup;
SQL
echo "02-backup-role.sh: role vdrkit_backup is ready (read-only, for backups)."
