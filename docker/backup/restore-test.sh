#!/bin/sh
# Monthly restore test: restores the newest backup into a throwaway database and checks it
# has tables. Uses the off-site copy when restic is configured, so that is the path tested.
# Fails if the newest backup is older than MAX_BACKUP_AGE_HOURS (default 48): a restore of a
# stale backup passing would hide that nightly backups have stopped.
set -euo pipefail
SCRIPT=restore-test
. /usr/local/bin/lib.sh

max_age_hours=${MAX_BACKUP_AGE_HOURS:-48}
testdb=diet_restore_test
work=$(mktemp -d)

cleanup() {
  rc=$?
  rm -rf "$work"
  psql -q -d postgres -c "drop database if exists $testdb" >/dev/null 2>&1 || true
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

take_lock

now=$(date +%s)
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic_repo_exists || fail "restic repository does not exist yet"
  # Snapshot times are RFC 3339 with the offset they were taken in, e.g.
  # 2026-11-05T19:26:40.123+01:00; jq's date parser only takes UTC "Z", so apply the offset.
  latest_epoch=$(restic snapshots --json --tag "$RESTIC_TAG" --host "$RESTIC_HOST" | jq -r '
    def offset: if endswith("Z") then 0 else .[-6:] as $o |
      ((($o[1:3] | tonumber) * 3600) + (($o[4:6] | tonumber) * 60)) *
      (if $o[0:1] == "-" then -1 else 1 end) end;
    map(.time | (.[0:19] + "Z" | fromdateiso8601) - offset) | max // empty')
  [ -n "$latest_epoch" ] || fail "no snapshots in $RESTIC_REPOSITORY"
  age_hours=$(((now - latest_epoch) / 3600))
  [ "$age_hours" -le "$max_age_hours" ] ||
    fail "STALE: newest off-site snapshot is ${age_hours}h old (limit ${max_age_hours}h); nightly uploads have stopped"

  log "checking repository integrity (5% sample)"
  restic check --read-data-subset=5% || fail "restic check"
  log "restoring latest snapshot (${age_hours}h old) from $RESTIC_REPOSITORY"
  restic restore latest --tag "$RESTIC_TAG" --host "$RESTIC_HOST" --target "$work" ||
    fail "restic restore"
  dump=$(find "$work" -name 'diet-*.dump' | sort | tail -n 1)
else
  log "RESTIC_REPOSITORY not set: testing the newest local dump only"
  dump=$(find "$BACKUP_DIR" -name 'diet-*.dump' | sort | tail -n 1)
  [ -n "$dump" ] || fail "no dump found in $BACKUP_DIR"
  age_hours=$(((now - $(stat -c %Y "$dump")) / 3600))
  [ "$age_hours" -le "$max_age_hours" ] ||
    fail "STALE: newest local dump is ${age_hours}h old (limit ${max_age_hours}h); nightly backups have stopped"
fi
[ -n "$dump" ] || fail "no dump found"

log "restoring $(basename "$dump") into $testdb"
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $testdb" -c "create database $testdb"
pg_restore --no-owner --exit-on-error --dbname "$testdb" "$dump" || fail "pg_restore"

tables=$(psql -tA -d "$testdb" -c "select count(*) from information_schema.tables where table_schema = 'public'")
[ "$tables" -gt 0 ] || fail "restored database has no tables"

log "OK: $tables tables restored from $(basename "$dump")"
