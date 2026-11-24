#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# usage: backup.sh daemon | now | list | verify NAME | restore-files NAME | health
# Database first, then files. quarantine/ is unencrypted and never backed up.
# .env is not included; without its keys a backup can't be read.
set -eu
# root only
umask 077

BACKUP_DIR=${BACKUP_DIR:-/backups}
FILES_DIR=${FILES_DIR:-/data/storage}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
AT=${BACKUP_AT:-02:30}
RETRIES=${BACKUP_RETRIES:-3}
RETRY_MINUTES=${BACKUP_RETRY_MINUTES:-15}
DRIVER=${STORAGE_DRIVER:-local}
[ -n "$DRIVER" ] || DRIVER=local
# uid of the node user in the VDRkit image
FILES_UID=${FILES_UID:-1000}

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

db_url() {
  [ -n "${BACKUP_DATABASE_URL:-}" ] || fail "BACKUP_DATABASE_URL is not set."
  case "$BACKUP_DATABASE_URL" in
    *vdrkit_backup:@*) fail "VDRKIT_BACKUP_PASSWORD is empty. Set it in .env (see docker/postgres-init/02-backup-role.sh)." ;;
  esac
  printf '%s' "$BACKUP_DATABASE_URL"
}

backup_now() {
  url=$(db_url)
  mkdir -p "$BACKUP_DIR"
  name="vdrkit-$(date -u +%Y%m%dT%H%M%SZ)"
  part="$BACKUP_DIR/.partial-$name"
  rm -rf "$part"
  mkdir -p "$part"
  started=$(date +%s)
  log "Backup $name started."

  # fail fast on a bad password, don't prompt
  pg_dump --no-password --format=custom --compress=6 --file="$part/database.dump" "$url" \
    || { rm -rf "$part"; fail "pg_dump failed. Nothing was kept."; }
  info=$(psql --no-password -X -A -t -F '|' "$url" -c \
    "select current_database(), current_setting('server_version'), (select count(*) from schema_migrations), (select max(name) from schema_migrations)") \
    || { rm -rf "$part"; fail "Could not read the migrations table."; }

  if [ "$DRIVER" = "local" ]; then
    [ -d "$FILES_DIR" ] || { rm -rf "$part"; fail "$FILES_DIR is missing: the files volume is not mounted."; }
    rc=0
    tar -C "$FILES_DIR" --numeric-owner \
      --warning=no-file-changed --warning=no-file-removed --warning=no-file-shrank \
      --anchored --exclude=./quarantine --exclude=./health --no-anchored --exclude='*.tmp' \
      -czf "$part/files.tar.gz" . || rc=$?
    if [ "$rc" -gt 1 ]; then rm -rf "$part"; fail "Packing the files failed (tar exit code $rc). Nothing was kept."; fi
    if [ "$rc" -eq 1 ]; then log "Files were added or deleted while they were packed (VDRkit is in use). Every complete file is in the backup."; fi
    files_note="files.tar.gz holds the files volume, without uploads in progress (quarantine/), health probes and files being written"
  else
    files_note="STORAGE_DRIVER=$DRIVER: files are in the bucket, not in this backup. Replicate the bucket (docs/install.md, \"Backups\")."
  fi

  {
    echo "VDRkit backup $name"
    echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "database=$(echo "$info" | cut -d'|' -f1)"
    echo "postgres_version=$(echo "$info" | cut -d'|' -f2)"
    echo "migrations_applied=$(echo "$info" | cut -d'|' -f3)"
    echo "last_migration=$(echo "$info" | cut -d'|' -f4)"
    echo "storage_driver=$DRIVER"
    echo "note=$files_note"
    echo "keys=not included: restore needs the VDRKIT_MASTER_KEY and BETTER_AUTH_SECRET of the .env this was made with"
  } > "$part/manifest.txt"
  (cd "$part" && sha256sum database.dump manifest.txt $( [ -f files.tar.gz ] && echo files.tar.gz ) > SHA256SUMS)

  verify_dir "$part" || { rm -rf "$part"; fail "The new backup did not verify. Nothing was kept."; }
  mv "$part" "$BACKUP_DIR/$name"
  echo "$name" > "$BACKUP_DIR/LATEST"
  date -u +%s > "$BACKUP_DIR/LAST_SUCCESS"
  size=$(du -sh "$BACKUP_DIR/$name" | cut -f1)
  log "Backup $name finished in $(( $(date +%s) - started )) seconds, $size."
  prune
}

verify_dir() {
  dir=$1
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || return 1
  pg_restore --list "$dir/database.dump" > /dev/null || return 1
  if [ -f "$dir/files.tar.gz" ]; then gzip -t "$dir/files.tar.gz" || return 1; fi
  return 0
}

backup_path() {
  name=${1:-}
  [ -n "$name" ] || fail "Name a backup, for example $(cat "$BACKUP_DIR/LATEST" 2>/dev/null || echo vdrkit-20261116T023000Z). See: list"
  case "$name" in vdrkit-*) ;; *) fail "\"$name\" is not a backup name." ;; esac
  case "$name" in */*|*..*) fail "\"$name\" is not a backup name." ;; esac
  [ -d "$BACKUP_DIR/$name" ] || fail "No backup $name in $BACKUP_DIR."
  printf '%s' "$BACKUP_DIR/$name"
}

prune() {
  latest=$(cat "$BACKUP_DIR/LATEST" 2>/dev/null || true)
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'vdrkit-*' -mtime "+$KEEP_DAYS" | while read -r old; do
    [ "$(basename "$old")" = "$latest" ] && continue
    rm -rf "$old" && log "Removed $(basename "$old"), older than $KEEP_DAYS days."
  done
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.partial-vdrkit-*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
}

restore_files() {
  dir=$(backup_path "${1:-}")
  verify_dir "$dir" || fail "Backup $(basename "$dir") does not verify. Nothing was restored."
  [ -f "$dir/files.tar.gz" ] || fail "Backup $(basename "$dir") holds no files ($(grep '^note=' "$dir/manifest.txt" | cut -d= -f2-))."
  mkdir -p "$FILES_DIR"
  if [ -n "$(ls -A "$FILES_DIR" 2>/dev/null)" ] && [ "${FORCE:-}" != "1" ]; then
    fail "$FILES_DIR is not empty. Restore into a fresh installation (see docs/install.md), or set FORCE=1 to unpack over it."
  fi
  tar -C "$FILES_DIR" --numeric-owner -xzf "$dir/files.tar.gz"
  chown -R "$FILES_UID:$FILES_UID" "$FILES_DIR"
  log "Files of $(basename "$dir") restored: $(find "$FILES_DIR" -type f | wc -l) files."
}

list() {
  [ -d "$BACKUP_DIR" ] || { echo "No backups yet."; return 0; }
  found=0
  for d in "$BACKUP_DIR"/vdrkit-*; do
    [ -d "$d" ] || continue
    found=1
    echo "$(basename "$d")  $(du -sh "$d" | cut -f1)  $(grep '^last_migration=' "$d/manifest.txt" | cut -d= -f2)"
  done
  [ "$found" = 1 ] || echo "No backups yet."
}

seconds_until_next() {
  now=$(date -u +%s)
  next=$(date -u -d "today $AT" +%s) || fail "BACKUP_AT=\"$AT\" is not a time such as 02:30."
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

daemon() {
  date -u +%s > /tmp/backup-started
  trap 'log "Stopping."; exit 0' TERM INT
  log "Daily backups at $AT UTC into $BACKUP_DIR, kept for $KEEP_DAYS days. Storage driver: $DRIVER."
  # separate process per try, so set -e only ends that try
  if [ "${BACKUP_ON_START:-}" = "1" ]; then backup_with_retries; fi
  while true; do
    wait_s=$(seconds_until_next)
    log "Next backup in $((wait_s / 3600)) h $(((wait_s % 3600) / 60)) min."
    sleep "$wait_s" & wait $!
    backup_with_retries
  done
}

backup_with_retries() {
  try=0
  until sh "$0" now; do
    try=$((try + 1))
    if [ "$try" -gt "$RETRIES" ]; then
      log "This backup failed $try times. The previous ones are kept; the next try is at $AT UTC."
      return 0
    fi
    log "This backup failed. Trying again in $RETRY_MINUTES minutes ($try of $RETRIES)."
    sleep $((RETRY_MINUTES * 60)) & wait $!
  done
}

health() {
  now=$(date -u +%s)
  last=$(cat "$BACKUP_DIR/LAST_SUCCESS" 2>/dev/null || echo 0)
  started=$(cat /tmp/backup-started 2>/dev/null || echo "$now")
  limit=$((26 * 3600))
  if [ $((now - last)) -lt "$limit" ] || [ $((now - started)) -lt "$limit" ]; then exit 0; fi
  echo "The last successful backup is more than 26 hours old." >&2
  exit 1
}

cmd=${1:-daemon}
[ $# -gt 0 ] && shift
case "$cmd" in
  daemon) daemon ;;
  now) backup_now ;;
  list) list ;;
  verify) d=$(backup_path "${1:-}"); verify_dir "$d" && log "Backup $(basename "$d") verifies." || fail "Backup $(basename "$d") does not verify." ;;
  restore-files) restore_files "${1:-}" ;;
  health) health ;;
  *) fail "Unknown command \"$cmd\". Use daemon, now, list, verify NAME, restore-files NAME or health." ;;
esac
