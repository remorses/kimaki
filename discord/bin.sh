#!/usr/bin/env bash
# Restarts dist/cli.js if it exits non-zero.
# Throttles restarts to at most once every 5 seconds.

set -u -o pipefail

NODE_BIN="${NODE_BIN:-node}"


last_start=0

while :; do
  now=$(date +%s)
  elapsed=$(( now - last_start ))
  if (( elapsed < 5 )); then
    sleep $(( 5 - elapsed ))
  fi
  last_start=$(date +%s)

  "$NODE_BIN" "./dist/cli.js" "$@"
  code=$?

  # Exit cleanly if the app ended OK or via SIGINT/SIGTERM
  if (( code == 0 || code == 130 || code == 143 || code == 64 )); then
    exit "$code"
  fi
  # otherwise loop; the 5s throttle above will apply
done
