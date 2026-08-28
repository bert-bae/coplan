#!/bin/sh
# cc-harness hook relay.
#
# Forwards one Claude Code hook payload to the local harness daemon and echoes
# the daemon's JSON response back as the hook's output.
#
#   usage: hook-relay.sh <EventName>
#
# Two properties matter more than anything else here:
#
#   1. Fail open. If the daemon is down, unreachable, slow, or returns
#      garbage, this must print nothing and exit 0. A hook that errors shows
#      up inside the user's session, and this plugin is installed globally.
#   2. No Node startup cost. This runs on every tool call, so it is sh + curl
#      rather than a Node process.

set -u

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

PAYLOAD=$(cat)
[ -n "$PAYLOAD" ] || exit 0

HOME_DIR="${CC_HARNESS_HOME:-$HOME/.claude/cc-harness}"
LOCK="$HOME_DIR/daemon.json"

# The Stop hook parks the turn while the user works through a review gate, so
# it needs a long budget. Everything else should be effectively instant.
case "$EVENT" in
  Stop) MAX_TIME=570 ;;
  UserPromptSubmit) MAX_TIME=20 ;;
  *) MAX_TIME=15 ;;
esac

command -v curl >/dev/null 2>&1 || exit 0

read_lock() {
  [ -f "$LOCK" ] || return 1
  PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$LOCK" | head -n 1)
  TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LOCK" | head -n 1)
  PID=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$LOCK" | head -n 1)
  [ -n "${PORT:-}" ] && [ -n "${TOKEN:-}" ] || return 1
  # A lock left behind by a crashed daemon is worse than no lock at all.
  if [ -n "${PID:-}" ] && ! kill -0 "$PID" 2>/dev/null; then
    return 1
  fi
  return 0
}

start_daemon() {
  # Only SessionStart pays the cost of starting the daemon; every other event
  # in a session that has no daemon simply no-ops.
  [ "$EVENT" = "SessionStart" ] || return 1
  [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  ENTRY="$CLAUDE_PLUGIN_ROOT/dist/daemon/main.js"
  [ -f "$ENTRY" ] || return 1
  mkdir -p "$HOME_DIR" 2>/dev/null || true
  (setsid node "$ENTRY" >/dev/null 2>&1 &) 2>/dev/null || (node "$ENTRY" >/dev/null 2>&1 &)
  i=0
  while [ "$i" -lt 50 ]; do
    sleep 0.1 2>/dev/null || sleep 1
    if read_lock; then return 0; fi
    i=$((i + 1))
  done
  return 1
}

if ! read_lock; then
  start_daemon || exit 0
fi

RESPONSE=$(printf '%s' "$PAYLOAD" | curl -s -S \
  --max-time "$MAX_TIME" \
  --connect-timeout 2 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @- \
  "http://127.0.0.1:$PORT/hook/$EVENT" 2>/dev/null) || exit 0

# Only emit something that actually looks like hook JSON. Anything else (an
# error page, a truncated body) is safer left unsaid.
case "$RESPONSE" in
  '{'*) printf '%s' "$RESPONSE" ;;
  *) : ;;
esac

exit 0
