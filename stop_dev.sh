#!/usr/bin/env bash
# Stops only the processes recorded by start_dev.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$REPO/.krobi-dev"

stop_recorded() {
  local file="$1"
  local label="$2"
  [ -f "$file" ] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$file")"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    echo "Stopped $label (PID $pid)."
  fi
  unlink "$file"
}

stop_recorded "$STATE_DIR/tauri.pid" "Tauri"
stop_recorded "$STATE_DIR/backend.pid" "FastAPI"
rmdir "$STATE_DIR" >/dev/null 2>&1 || true
