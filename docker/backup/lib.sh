# Shared helpers for backup.sh and restore-test.sh. Sourced, not executed.

BACKUP_DIR=/backups
LOCK_FILE="$BACKUP_DIR/.backup.lock"
RESTIC_TAG=diet-planner
RESTIC_HOST=diet-planner

log() { echo "[$SCRIPT $(date -Iseconds)] $*"; }
fail() {
  echo "[$SCRIPT $(date -Iseconds)] FAILED: $*"
  exit 1
}

# One backup or restore test at a time: a manual run overlapping with cron waits (up to an
# hour) instead of deleting the other run's files or racing on `restic init`.
take_lock() {
  exec 9>"$LOCK_FILE"
  waited=0
  # busybox flock has no timeout option, so poll.
  until flock -n 9; do
    [ "$waited" -lt 3600 ] || fail "another backup or restore test has held the lock for an hour"
    [ "$waited" -gt 0 ] || log "waiting for another backup or restore test to finish"
    sleep 10
    waited=$((waited + 10))
  done
}

# 0 = repository exists, 1 = repository does not exist yet. Anything else (wrong password,
# bad credentials, network) is a hard failure, never a reason to `restic init`.
restic_repo_exists() {
  set +e
  restic cat config >/dev/null 2>&1
  rc=$?
  set -e
  case $rc in
    0) return 0 ;;
    10) return 1 ;; # restic: "repository does not exist"
    *) fail "cannot open restic repository (exit $rc): check credentials, password and network" ;;
  esac
}
