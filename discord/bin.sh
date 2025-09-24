#!/usr/bin/env bash
# Restarts dist/cli.js if it exits non-zero.
# Throttles restarts to at most once every 5 seconds.

set -u -o pipefail

NODE_BIN="${NODE_BIN:-node}"

# Resolve target relative to this script file
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET="${TARGET:-"$SCRIPT_DIR/../dist/cli.js"}"

last_start=0

while :; do
  now=$(date +%s)
  elapsed=$(( now - last_start ))
  if (( elapsed < 5 )); then
    sleep $(( 5 - elapsed ))
  fi
  last_start=$(date +%s)

  "$NODE_BIN" "$TARGET" "$@"
  code=$?

  # Exit cleanly if the app ended OK or via SIGINT/SIGTERM
  if (( code == 0 || code == 130 || code == 143 )); then
    exit "$code"
  fi
  # otherwise loop; the 5s throttle above will apply
done
