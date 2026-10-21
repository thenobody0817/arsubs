#!/usr/bin/env bash
# Start the arsubs client server and point the Quest 3 at it.
#
#   ./run.sh            start server, tunnel, wake headset, open the page
#   ./run.sh --tunnel   only re-arm the adb reverse tunnel
#   ./run.sh --logs     tail the client's self-reported state
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8787}"
# Override if adb ever enumerates the headset differently.
QUEST="${QUEST:-2G0YC5ZG1W00QH}"
LOG="$HERE/logs/server.log"

mkdir -p "$HERE/logs"

quest() { adb -s "$QUEST" "$@"; }

if [[ "${1:-}" == "--tunnel" ]]; then
  quest reverse --remove-all >/dev/null 2>&1 || true
  quest reverse "tcp:$PORT" "tcp:$PORT"
  echo "tunnel: localhost:$PORT -> host:$PORT"
  exit 0
fi

if [[ "${1:-}" == "--logs" ]]; then
  tail -f "$HERE/logs/client.log"
  exit 0
fi

if [[ "${1:-}" == "--stop" ]]; then
  pkill -f "$HERE/keepawake.sh" 2>/dev/null && echo "keepawake: stopped" || echo "keepawake: was not running"
  exit 0
fi

if ! pgrep -f "node $HERE/server.mjs" >/dev/null 2>&1; then
  cd "$HERE"
  setsid node server.mjs >"$LOG" 2>&1 </dev/null &
  sleep 1.2
fi
echo "server:  http://127.0.0.1:$PORT  (pid $(pgrep -f "node $HERE/server.mjs" | head -1))"

if ! quest get-state >/dev/null 2>&1; then
  echo "headset $QUEST not on adb — connect the USB cable and put it on." >&2
  exit 1
fi

quest reverse --remove-all >/dev/null 2>&1 || true
quest reverse "tcp:$PORT" "tcp:$PORT"
echo "tunnel:  headset localhost:$PORT -> host:$PORT"

# The Quest suspends on wear-detection no matter what `svc power stayon` says, and
# a suspended headset will not fetch the page — which looks exactly like a broken
# tunnel. keepawake.sh polls the power service and re-wakes it until killed.
if ! pgrep -f "$HERE/keepawake.sh" >/dev/null 2>&1; then
  setsid "$HERE/keepawake.sh" >"$HERE/logs/keepawake.log" 2>&1 </dev/null &
  sleep 0.5
  echo "keepawake: running ($HERE/keepawake.sh --status to check)"
else
  echo "keepawake: already running"
fi
quest shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
quest shell svc power stayon true >/dev/null 2>&1 || true

# Reuse the existing window instead of opening another one. Every distinct URL
# makes the headset browser create a new task, and a pile of those is impossible
# to tell apart once you have more than two. A single stable URL that reloads in
# place keeps exactly one window on the headset at all times.
quest shell am force-stop com.oculus.browser >/dev/null 2>&1 || true
sleep 0.5
quest shell am start -a android.intent.action.VIEW \
  -d "http://localhost:$PORT/" >/dev/null 2>&1 || true

cat <<EOF

Opened http://localhost:$PORT/ in the headset browser.

  $HERE/keepawake.sh --status          # want: Awake
  curl -s localhost:$PORT/state          # want: the headset's self-report
  $HERE/run.sh --logs                    # follow events as they land

The headset is being held awake, so you do not need to wear it to load the page
— but WebXR still needs the headset on your face to render. If /state stays
empty while the tunnel answers from the device, check the watchdog log.
EOF
