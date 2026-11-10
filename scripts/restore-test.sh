#!/usr/bin/env bash
# Restores the latest snapshot into a throwaway folder and checks that the database opens, with its tables and projects.
# Usage: scripts/restore-test.sh [expected-project-count]   (same settings as backup.sh)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected="${1:-}"
container="${REDLINE_BACKUP_CONTAINER:-$(cd "$root" && docker compose ps -q redline)}"
[ -n "$container" ] || { echo "The Redline container is not running (it provides the image used to open the database)." >&2; exit 1; }
image="$(docker inspect -f '{{.Image}}' "$container")"

target="$(mktemp -d "${TMPDIR:-/tmp}/redline-restore-test.XXXXXX")"
# Restored files keep the owner of the volume (uid 1000), so they are removed from a container.
trap 'docker run --rm -v "$target:/restore" --entrypoint rm "$image" -rf /restore/data; rmdir "$target"' EXIT

(cd "$target" && "$root/scripts/backup.sh" restic restore latest --tag redline --target . > /dev/null)

database="$(find "$target" -name redline.db -path '*/backup/*' | head -n 1)"
[ -n "$database" ] || { echo "No database in the latest snapshot." >&2; exit 1; }
blobs="$(find "$target" -type d -name blobs | head -n 1)"
[ -n "$blobs" ] || { echo "No blobs folder in the latest snapshot." >&2; exit 1; }

projects="$(docker run --rm -i -v "$target:/restore:ro" --entrypoint node "$image" - verify "/restore${database#"$target"}" < "$root/scripts/backup-db.cjs")"
if [ -n "$expected" ] && [ "$projects" != "$expected" ]; then
  echo "The restored database holds $projects project(s), expected $expected." >&2
  exit 1
fi
echo "Restore test passed: database opens, $projects project(s), $(find "$blobs" -type f | wc -l | tr -d ' ') blob file(s)."
