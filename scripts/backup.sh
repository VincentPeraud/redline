#!/usr/bin/env bash
# Nightly backup of a Redline server (run it from the host's cron), see README, "Backup".
#   scripts/backup.sh                 consistent SQLite copy + blobs -> restic repository, retention, weekly partial check
#   scripts/backup.sh restic <args>   runs restic against the same repository; the current folder is mounted as /restore
#                                     (e.g. `scripts/backup.sh restic restore latest --target .`)
# Settings live in a host folder outside git (REDLINE_BACKUP_CONFIG_DIR, default ~/.config/redline-backup), readable by its owner only:
#   repository        required  restic repository: sftp:user@host:/path, s3:..., an absolute local folder, or volume:<docker volume>
#   password          required  restic repository password
#   env               optional  KEY=VALUE lines for the repository (e.g. AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
#   ssh-key           optional  private key for sftp repositories
#   known_hosts       optional  known hosts for sftp repositories (host key is then checked strictly)
#   webhook-success   optional  URL receiving {"text": ...} after a successful backup
#   webhook-failure   optional  URL receiving {"text": ...} after a failed backup
# REDLINE_BACKUP_CONTAINER overrides the Redline container (default: the `redline` service of this repository's compose file).
set -euo pipefail
umask 077

RESTIC_IMAGE="restic/restic@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76"
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=6
LOG_DAYS=30

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${REDLINE_BACKUP_CONFIG_DIR:-$HOME/.config/redline-backup}"
step="start"
restic_mounts=()

die() {
  echo "$*" >&2
  exit 1
}

file_mode() {
  stat -c %a "$1" 2> /dev/null || stat -f %Lp "$1"
}

check_config_folder() {
  [ -d "$config_dir" ] || die "Backup configuration folder $config_dir does not exist (see README, \"Backup\")."
  local path mode
  while IFS= read -r path; do
    mode="$(file_mode "$path")"
    if (( (8#$mode & 8#077) != 0 )); then
      die "Refusing to run: $path is accessible by group or others (mode $mode). Run: chmod 700 $config_dir && chmod 600 $config_dir/*"
    fi
  done < <(find "$config_dir" -maxdepth 1 \( -type d -o -type f \))
  [ -s "$config_dir/repository" ] || die "Missing $config_dir/repository."
  [ -s "$config_dir/password" ] || die "Missing $config_dir/password."
}

restic_docker() {
  local extra=() repository ssh_args=""
  repository="$(tr -d '\n' < "$config_dir/repository")"
  if [[ "$repository" == /* ]]; then
    extra+=(-v "$repository:/repository")
    repository="/repository"
  elif [[ "$repository" == volume:* ]]; then
    extra+=(-v "${repository#volume:}:/repository")
    repository="/repository"
  fi
  if [ -s "$config_dir/env" ]; then extra+=(--env-file "$config_dir/env"); fi
  if [ -s "$config_dir/ssh-key" ]; then ssh_args="-i /config/ssh-key -o IdentitiesOnly=yes"; fi
  if [ -s "$config_dir/known_hosts" ]; then ssh_args="$ssh_args -o UserKnownHostsFile=/config/known_hosts -o StrictHostKeyChecking=yes"; fi
  if [ -n "$ssh_args" ]; then set -- -o "sftp.args=$ssh_args" "$@"; fi
  docker run --rm --hostname redline-backup \
    -v "$config_dir:/config:ro" \
    -e RESTIC_REPOSITORY="$repository" -e RESTIC_PASSWORD_FILE=/config/password -e RESTIC_CACHE_DIR=/tmp/restic-cache \
    ${extra[@]+"${extra[@]}"} "${restic_mounts[@]}" "$RESTIC_IMAGE" "$@"
}

json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  printf '%s' "$text"
}

notify() {
  local file="$config_dir/webhook-$1" url
  [ -s "$file" ] || return 0
  url="$(tr -d '[:space:]' < "$file")"
  curl -fsS -m 20 -H 'Content-Type: application/json' -d "{\"text\":\"$(json_escape "$2")\"}" "$url" > /dev/null \
    || echo "The $1 webhook could not be called."
}

if [ "${1:-}" = "restic" ]; then
  shift
  check_config_folder
  restic_mounts=(-v "$PWD:/restore" -w /restore)
  restic_docker "$@"
  exit
fi

[ "$#" -eq 0 ] || die "Usage: scripts/backup.sh [restic <args>]"
check_config_folder

logs_dir="$config_dir/logs"
lock_dir="$config_dir/backup.lock"
mkdir -p "$logs_dir"
find "$logs_dir" -name 'backup-*.log' -mtime "+$LOG_DAYS" -delete
log_file="$logs_dir/backup-$(date +%Y-%m-%d).log"

if ! mkdir "$lock_dir" 2> /dev/null; then
  if kill -0 "$(cat "$lock_dir/pid" 2> /dev/null)" 2> /dev/null; then
    die "Another backup is running (lock $lock_dir)."
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir"
fi
echo $$ > "$lock_dir/pid"

exec > >(tee -a "$log_file") 2>&1

finish() {
  local status=$?
  rm -rf "$lock_dir"
  if [ "$status" -ne 0 ]; then
    echo "$(date '+%F %T') FAILED at step: $step"
    notify failure "Redline backup failed on $(hostname) at step \"$step\". Log: $log_file"
  fi
  exit "$status"
}
trap finish EXIT

echo "$(date '+%F %T') Backup started"

step="locate the Redline container"
container="${REDLINE_BACKUP_CONTAINER:-$(cd "$root" && docker compose ps -q redline)}"
[ -n "$container" ] || die "The Redline container is not running."
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")"
[ -n "$volume" ] || die "The Redline container has no named volume on /data."

step="consistent copy of the database"
docker exec "$container" mkdir -p /data/backup
projects="$(docker exec -i "$container" node - snapshot /data/redline.db /data/backup/redline.db < "$root/scripts/backup-db.cjs")"
echo "Database copy checked: $projects project(s)"

restic_mounts=(-v "$volume:/data:ro")

step="restic repository"
restic_docker cat config > /dev/null 2>&1 || restic_docker init

step="restic backup"
restic_docker backup --host redline --tag redline /data/backup/redline.db /data/blobs

step="retention (forget --prune)"
restic_docker forget --host redline --tag redline --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune

if [ "$(date +%u)" = "7" ]; then
  step="weekly check"
  restic_docker check --read-data-subset=5%
fi

step="done"
echo "$(date '+%F %T') Backup finished"
notify success "Redline backup done on $(hostname): $projects project(s)."
