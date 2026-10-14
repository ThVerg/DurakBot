#!/usr/bin/env bash
# Build the frontend if needed and serve DurakBot on 0.0.0.0:8000 (override with HOST/PORT).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

needs_build() {
  [ ! -f web/dist/index.html ] && return 0
  [ -n "$(find web/src web/index.html web/package.json web/vite.config.ts -newer web/dist/index.html -print -quit 2>/dev/null)" ]
}

if [ "${SKIP_BUILD:-0}" != "1" ] && needs_build; then
  echo "[serve] building frontend..."
  (
    cd web
    [ -d node_modules ] || npm ci --no-audit --no-fund || npm install --no-audit --no-fund
    npm run build
  )
fi

echo "[serve] DurakBot on http://${HOST}:${PORT}"
exec "$ROOT/.venv/bin/python" -m uvicorn server.app:app --host "$HOST" --port "$PORT" ${UVICORN_ARGS:-}
