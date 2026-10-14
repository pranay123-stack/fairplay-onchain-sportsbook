#!/usr/bin/env bash
# Start/stop the local API and web dev servers in the background (logs in .fairplay/).
#   scripts/stack.sh start | stop | restart | status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.fairplay"
# Which configuration to run: .env (local Anvil, default) or e.g. FAIRPLAY_ENV_FILE=.env.sepolia
ENV_FILE="$ROOT/${FAIRPLAY_ENV_FILE:-.env}"
mkdir -p "$STATE"

start_one() { # name dir cmd...
  local name=$1 dir=$2; shift 2
  if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  # The child records its own pid, then execs the server as the leader of a new session/process group.
  (cd "$dir" && setsid bash -c 'echo $$ >"$0"; exec "$@"' "$STATE/$name.pid" "$@" >"$STATE/$name.log" 2>&1 </dev/null &)
  sleep 0.3
  echo "$name started (log: .fairplay/$name.log)"
}

stop_one() {
  local name=$1
  [ -f "$STATE/$name.pid" ] || { echo "$name not running"; return; }
  local pid; pid=$(cat "$STATE/$name.pid")
  # setsid made the server its own process-group leader: kill the whole group.
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  rm -f "$STATE/$name.pid"; echo "$name stopped"
}

case "${1:-status}" in
  start)
    [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
    echo "configuration: ${ENV_FILE#$ROOT/}"
    start_one api "$ROOT/apps/api" npx tsx --env-file="$ENV_FILE" src/main.ts
    # The web app reads NEXT_PUBLIC_* (network, API URL, browser RPC) from the same file.
    WEB_PORT=$(grep -E '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2); WEB_PORT=${WEB_PORT:-3600}
    ( set -a; . <(grep -E '^NEXT_PUBLIC_[A-Z_]+=' "$ENV_FILE"); set +a
      start_one web "$ROOT/apps/web" npx next dev --port "$WEB_PORT" )
    ;;
  stop) stop_one web; stop_one api ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status)
    for n in api web; do
      if [ -f "$STATE/$n.pid" ] && kill -0 "$(cat "$STATE/$n.pid")" 2>/dev/null; then echo "$n: running (pid $(cat "$STATE/$n.pid"))"; else echo "$n: stopped"; fi
    done
    ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
