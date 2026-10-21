#!/usr/bin/env bash
# Keep the Quest 3 awake for as long as this script runs.
#
# The VR shell suspends on wear-detection regardless of `svc power stayon` and
# `stay_on_while_plugged_in`, so those settings are applied as a baseline but
# the real work here is a poll loop that re-wakes the device whenever the
# power service drops to Asleep. A suspended headset cannot even fetch the page,
# which is indistinguishable from a broken tunnel — this removes that as a
# variable.
#
#   ./keepawake.sh            run until Ctrl-C
#   ./keepawake.sh --status   one-shot report
set -uo pipefail

QUEST="${QUEST:-2G0YC5ZG1W00QH}"
POLL="${POLL:-4}"

q() { adb -s "$QUEST" "$@" 2>/dev/null; }

wakefulness() {
  q shell dumpsys power 2>/dev/null | grep -oE 'mWakefulness=[A-Za-z]+' | head -1 | cut -d= -f2
}

if [[ "${1:-}" == "--status" ]]; then
  echo "headset $QUEST: $(wakefulness)"
  exit 0
fi

q get-state >/dev/null 2>&1 || { echo "headset $QUEST not on adb" >&2; exit 1; }

# Baseline: never auto-sleep on power, and stay awake while plugged in.
q shell svc power stayon true
q shell settings put global stay_on_while_plugged_in 3
q shell settings put system screen_off_timeout 86400000

echo "keeping $QUEST awake — Ctrl-C to stop"
wakes=0
while true; do
  w=$(wakefulness)
  if [[ "$w" == "Asleep" ]]; then
    q shell input keyevent KEYCODE_WAKEUP
    q shell am start -n com.oculus.vrshell/.HomeActivity >/dev/null 2>&1
    wakes=$((wakes + 1))
    echo "$(date +%H:%M:%S) asleep -> woke (${wakes})"
  fi
  sleep "$POLL"
done