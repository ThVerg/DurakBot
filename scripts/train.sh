#!/usr/bin/env bash
# Launch or resume a fully detached PPO self-play run.
#   scripts/train.sh                 # run "main" (resumes if runs/main/state.pt exists)
#   NAME=exp2 WORKERS=8 scripts/train.sh --max-hours 24
#   scripts/train.sh --stop          # stop the run gracefully (saves state)
# Extra args are passed to `python -m durak.rl.train` (see --help).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${NAME:-main}"
WORKERS="${WORKERS:-7}"
LTHREADS="${LTHREADS:-4}"
RUN="runs/$NAME"
mkdir -p "$RUN"
PIDFILE="$RUN/train.pid"

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill -TERM "$(cat "$PIDFILE")" && echo "sent SIGTERM to $(cat "$PIDFILE"); it saves state and exits"
  else
    echo "no running trainer for $NAME"
  fi
  exit 0
fi

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: PID $(cat "$PIDFILE") (scripts/train.sh --stop to stop)"; exit 1
fi

setsid nohup .venv/bin/python -m durak.rl.train --name "$NAME" --workers "$WORKERS" \
  --learner-threads "$LTHREADS" "$@" >> "$RUN/train.log" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
echo "started $NAME: PID $(cat "$PIDFILE"), log $RUN/train.log"
