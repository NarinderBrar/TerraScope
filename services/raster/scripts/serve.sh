#!/usr/bin/env bash
# Start the raster service fully detached and wait for readiness.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8080}"
LOG="${LOG:-/tmp/opencode/raster.log}"
PIDFILE="${PIDFILE:-/tmp/opencode/raster.pid}"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
fi
fuser -k -n tcp "$PORT" 2>/dev/null || true
sleep 1

cd "$ROOT"
# setsid detaches from the shell's process group so the server is not taken
# down when the invoking command returns.
PYTHONPATH=. setsid nohup .venv/bin/python -m uvicorn app.api.routes:app \
  --host 127.0.0.1 --port "$PORT" \
  > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
    echo "ready on ${PORT} (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  sleep 0.5
done

echo "failed to become ready; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
