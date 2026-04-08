#!/bin/bash
# Example runner for the system-prompt drift plugin.
# Starts one local opencode server with the example plugins, sends two prompts
# into the same session, and prints the second run output where the
# tui.toast.show event should appear.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-4097}"
MODEL="${MODEL:-opencode/kimi-k2.5}"
TMP_DIR="$SCRIPT_DIR/tmp"
SERVER_LOG="$TMP_DIR/opencode-serve.log"
RUN1_JSONL="$TMP_DIR/run-1.jsonl"
RUN2_OUTPUT="$TMP_DIR/run-2-output.txt"
KIMAKI_DATA_DIR="$TMP_DIR/kimaki-data"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$KIMAKI_DATA_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init >/dev/null 2>&1
fi

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "Starting opencode serve on port $PORT"
echo "Model: $MODEL"
echo "Working directory: $SCRIPT_DIR"
echo "Kimaki data dir: $KIMAKI_DATA_DIR"
echo ""

KIMAKI_DATA_DIR="$KIMAKI_DATA_DIR" \
  opencode serve --port "$PORT" --print-logs >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

sleep 2

echo "First turn: establish baseline system prompt"
opencode run \
  --attach "http://127.0.0.1:$PORT" \
  --dir "$SCRIPT_DIR" \
  --model "$MODEL" \
  --format json \
  "Reply with only the word baseline." | tee "$RUN1_JSONL"

SESSION_ID="$({
  printf '%s\n' "$(cat "$RUN1_JSONL")"
} | node -e '
let data = ""
process.stdin.on("data", (chunk) => {
  data += chunk
})
process.stdin.on("end", () => {
  for (const line of data.split(/\n/)) {
    if (!line.trim()) {
      continue
    }
    const event = JSON.parse(line)
    if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
      process.stdout.write(event.sessionID)
      return
    }
  }
  process.exit(1)
})
')"

if [ -z "$SESSION_ID" ]; then
  echo "Failed to capture session ID from first run" >&2
  exit 1
fi

echo ""
echo "Second turn: mutate system prompt and continue session $SESSION_ID"
opencode run \
  --attach "http://127.0.0.1:$PORT" \
  --dir "$SCRIPT_DIR" \
  --session "$SESSION_ID" \
  --model "$MODEL" \
  --format json \
  --print-logs \
  "Reply with only the word changed." 2>&1 | tee "$RUN2_OUTPUT"

echo ""
echo "Toast-related log lines:"
rg 'tui.toast.show|show-toast|System prompt changed|context cache' "$RUN2_OUTPUT" "$SERVER_LOG" || true

echo ""
echo "Server log: $SERVER_LOG"
echo "Diff files:"
find "$KIMAKI_DATA_DIR/system-prompt-diffs" -type f 2>/dev/null || true
