#!/bin/sh
# Nightly backup: a local pg_dump (kept 14 days) plus an encrypted off-site copy with restic
# (kept 90 days) when RESTIC_REPOSITORY is set.
set -euo pipefail
SCRIPT=backup
. /usr/local/bin/lib.sh

take_lock

# Partial dumps left by a crashed or killed run; safe to delete now that we hold the lock.
find "$BACKUP_DIR" -name 'diet-*.dump.partial' -delete

stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/diet-$stamp.dump"
trap 'rm -f "$out.partial"' EXIT INT TERM

log "dumping database to $out"
# Uncompressed custom format: restic compresses and deduplicates it far better.
pg_dump --format=custom --compress=0 --no-owner --file "$out.partial"
mv "$out.partial" "$out"

find "$BACKUP_DIR" -name 'diet-*.dump' -mtime +14 -delete

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  if ! restic_repo_exists; then
    log "initialising restic repository"
    restic init
  fi
  log "uploading to $RESTIC_REPOSITORY"
  restic backup --tag "$RESTIC_TAG" --host "$RESTIC_HOST" "$out"
  # Every dump has a new file name, so group by host only; otherwise each snapshot is its own
  # group and nothing ever expires.
  restic forget --tag "$RESTIC_TAG" --host "$RESTIC_HOST" --group-by host --keep-daily 90 --prune
else
  log "RESTIC_REPOSITORY not set: off-site copy SKIPPED"
fi

log "done"
