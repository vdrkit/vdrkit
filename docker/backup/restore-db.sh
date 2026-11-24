#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# usage (in the postgres container): sh /vdrkit-backup/restore-db.sh vdrkit-YYYYMMDDTHHMMSSZ
# superuser: forced RLS blocks COPY for every other role, owner included
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
DB=${POSTGRES_DB:-vdrkit}
name=${1:-}

fail() { echo "[restore] ERROR: $*" >&2; exit 1; }
q() { psql -X -v ON_ERROR_STOP=1 -A -t --username postgres --dbname "$DB" -c "$1"; }

[ -n "$name" ] || fail "Name a backup: ls $BACKUP_DIR"
case "$name" in vdrkit-*) ;; *) fail "\"$name\" is not a backup name." ;; esac
case "$name" in */*|*..*) fail "\"$name\" is not a backup name." ;; esac
dir="$BACKUP_DIR/$name"
[ -f "$dir/database.dump" ] || fail "No backup $name in $BACKUP_DIR. Is BACKUP_DIR mounted into the postgres service?"

(cd "$dir" && sha256sum --quiet -c SHA256SUMS) || fail "The checksums of $name do not match. Nothing was restored."

tables=$(q "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
[ "$tables" = "0" ] || fail "Database $DB already holds $tables tables. Restore only into a fresh installation (docs/install.md, \"Restore\")."

for role in vdrkit_owner vdrkit_app vdrkit_queue; do
  [ "$(q "select count(*) from pg_roles where rolname = '$role'")" = "1" ] \
    || fail "Role $role is missing. A fresh bundled Postgres creates it from .env (docker/postgres-init/01-roles.sh)."
done

echo "[restore] Restoring $name into $DB ($(grep '^last_migration=' "$dir/manifest.txt" | cut -d= -f2), made $(grep '^created_utc=' "$dir/manifest.txt" | cut -d= -f2))."
started=$(date +%s)
pg_restore --username postgres --dbname "$DB" --single-transaction --exit-on-error --no-password "$dir/database.dump" \
  || fail "pg_restore failed. The transaction was rolled back: the database is empty again."
q "analyze" > /dev/null
echo "[restore] Database restored in $(( $(date +%s) - started )) seconds: $(q "select count(*) from schema_migrations") migrations, $(q "select count(*) from event") events, $(q "select count(*) from workspace") rooms."
