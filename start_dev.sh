#!/usr/bin/env bash
# Starts FastAPI and the Tauri/Vite desktop app in separate macOS Terminal tabs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$REPO/.krobi-dev"
VENV="$REPO/.venv"

if [ ! -x "$VENV/bin/python" ]; then
  echo "Missing .venv. Run 'make install' first." >&2
  exit 1
fi
if [ ! -d "$REPO/node_modules" ]; then
  echo "Missing node_modules. Run 'npm install' first." >&2
  exit 1
fi
mkdir -p "$STATE_DIR"

run_in_terminal() {
  local command="$1"
  local title="$2"
  osascript - "$command" "$title" <<'EOF'
on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    set custom title of front window to (item 2 of argv)
  end tell
end run
EOF
}

backend="cd '$REPO/backend' && echo \$\$ > '$STATE_DIR/backend.pid' && exec '$VENV/bin/python' -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
desktop="cd '$REPO' && echo \$\$ > '$STATE_DIR/tauri.pid' && exec npm start"

run_in_terminal "$backend" "KROBI — FastAPI :8000"
until curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; do sleep 0.5; done
run_in_terminal "$desktop" "KROBI — Tauri"

echo "KROBI development environment started. API docs: http://127.0.0.1:8000/docs"
