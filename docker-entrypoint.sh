#!/usr/bin/env bash
set -euo pipefail

# Railway mounts persistent volumes owned by root with restrictive perms.
# Derive the volume's parent directory from $DB_PATH so we can chown it to
# the lumina user before dropping privileges. We only touch the directory
# (not the file) so existing data remains writable to its current owner.
DB_PATH="${DB_PATH:-./lumina.db}"
DB_DIR="$(dirname "$DB_PATH")"

if [ -d "$DB_DIR" ]; then
  chown -R lumina:lumina "$DB_DIR" 2>/dev/null || true
fi

# Drop privileges to lumina (uid 10001) and exec the original command.
exec gosu lumina "$@"
