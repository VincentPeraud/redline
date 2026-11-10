#!/usr/bin/env bash
# Creates the missing proxy secret files and writes the matching lines in .env. Never overwrites a value.
# Usage: scripts/generate-secrets.sh [env-file]   (default: .env at the repository root)
# REDLINE_SECRETS_DIR overrides the secrets folder (default: ./secrets at the repository root).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${1:-$root/.env}"
secrets_dir="${REDLINE_SECRETS_DIR:-$root/secrets}"

mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"
touch "$env_file"
# .env holds both proxy secrets: readable by its owner only.
chmod 600 "$env_file"

env_value() {
  grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- || true
}

is_secret() {
  [[ "$1" =~ ^[0-9a-f]{32,}$ ]]
}

set_env_line() {
  local name="$1" value="$2" tmp
  if grep -qE "^$name=" "$env_file"; then
    tmp="$(mktemp)"
    awk -v name="$name" -v value="$value" 'BEGIN { prefix = name "=" } index($0, prefix) == 1 { print prefix value; next } { print }' "$env_file" > "$tmp"
    cat "$tmp" > "$env_file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
  fi
}

ensure_secret() {
  local env_name="$1" file="$secrets_dir/$2" from_file="" from_env
  if [ -s "$file" ]; then from_file="$(tr -d '[:space:]' < "$file")"; fi
  from_env="$(env_value "$env_name")"

  if [ -n "$from_file" ] && ! is_secret "$from_file"; then
    echo "$file must hold lowercase hex of at least 32 characters; fix or delete it." >&2
    exit 1
  fi
  if [ -n "$from_env" ] && ! is_secret "$from_env"; then
    echo "$env_name in $env_file must be lowercase hex of at least 32 characters; fix or empty it." >&2
    exit 1
  fi
  if [ -n "$from_file" ] && [ -n "$from_env" ] && [ "$from_file" != "$from_env" ]; then
    echo "$env_name in $env_file differs from $file; keep the one in use and delete the other (see README, secret rotation)." >&2
    exit 1
  fi

  local value="${from_file:-$from_env}"
  if [ -z "$value" ]; then
    value="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    echo "Generated $env_name"
  fi
  if [ -z "$from_file" ]; then
    printf '%s\n' "$value" > "$file"
  fi
  # Readable by the container's non-root user; the folder itself stays private.
  chmod 644 "$file"
  if [ -z "$from_env" ]; then
    set_env_line "$env_name" "$value"
  fi
}

ensure_secret REDLINE_PROXY_SECRET_HUMAN proxy-secret-human
ensure_secret REDLINE_PROXY_SECRET_MACHINE proxy-secret-machine

if [ "$(env_value REDLINE_PROXY_SECRET_HUMAN)" = "$(env_value REDLINE_PROXY_SECRET_MACHINE)" ]; then
  echo "The human and machine secrets must differ; delete one of them and its .env line, then run again." >&2
  exit 1
fi
