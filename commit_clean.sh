#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <dataset-name>" >&2
  echo "Example: $0 win11-1" >&2
  exit 1
fi

DS="tank/$1"
SNAP="clean"

echo "Committing snapshot for $DS..."

# Проверяем существование звола
if ! zfs list "$DS" &>/dev/null; then
  echo "Error: ZFS dataset $DS not found." >&2
  exit 1
fi

# Удаляем старый snapshot (если есть)
if zfs list -H -t snapshot "$DS@$SNAP" &>/dev/null; then
  echo "Deleting existing snapshot $DS@$SNAP..."
  zfs destroy -f "$DS@$SNAP"
fi

# Создаём новый snapshot
echo "Creating new snapshot $DS@$SNAP..."
zfs snapshot "$DS@$SNAP"

echo "Done."