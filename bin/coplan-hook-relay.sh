#!/bin/sh
# Coplan hook relay.
#
# Forwards one agent hook payload to the local Coplan daemon and echoes the
# daemon's JSON response back as the hook's output.
#
#   usage: coplan-hook-relay.sh <EventName> [claude|codex|cursor]
#
# The agent defaults to Claude Code. Codex and Cursor name themselves in their
# own hook files (hooks/codex.json, hooks/cursor.json); the daemon reads each
# one's payload and answers in that agent's format.
#
# Two properties matter more than anything else here:
#
#   1. Fail open. If the daemon is down, unreachable, slow, or returns
#      garbage, this must print nothing and exit 0. A hook that errors shows
#      up inside the user's session, and this plugin is installed globally.
#   2. No Node startup cost. This runs on every prompt and every turn end, so
#      it is sh + curl rather than a Node process.

set -u

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0
AGENT="${2:-claude}"
case "$AGENT" in
  claude|codex|cursor) ;;
  *) AGENT=claude ;;
esac

# Where the plugin lives. Claude Code and Codex say so in CLAUDE_PLUGIN_ROOT /
# PLUGIN_ROOT; Cursor may not, and this script always knows where it is.
SELF_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd) || SELF_ROOT=
PLUGIN_ROOT_DIR="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-$SELF_ROOT}}}"

PAYLOAD=$(cat)
[ -n "$PAYLOAD" ] || exit 0

HOME_DIR="${CC_HARNESS_HOME:-$HOME/.claude/cc-harness}"
LOCK="$HOME_DIR/daemon.json"

# Nothing the harness does waits on the user, so every event is near instant.
case "$EVENT" in
  SessionStart|sessionStart) MAX_TIME=15 ;;
  *) MAX_TIME=4 ;;
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
  # Only the session's first event pays the cost of starting the daemon; every
  # other event in a session that has no daemon simply no-ops.
  case "$EVENT" in
    SessionStart|sessionStart) ;;
    *) return 1 ;;
  esac
  [ -n "$PLUGIN_ROOT_DIR" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  ENTRY="$PLUGIN_ROOT_DIR/dist/daemon/main.js"
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

# Hooks run inside the session's own environment, which is the only place
# that says where the session lives — and therefore how to link back to it so
# the user can answer the agent there. Remote Control can be switched on
# mid-session, so this goes with every event rather than only SessionStart.
RESPONSE=$(printf '%s' "$PAYLOAD" | curl -s -S \
  --max-time "$MAX_TIME" \
  --connect-timeout 2 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Harness-Agent: $AGENT" \
  -H "X-Harness-Remote-Session: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}" \
  -H "X-Harness-Remote-Sdk: ${CLAUDE_CODE_REMOTE_SDK_URL:-}" \
  -H "X-Harness-Bridge-Session: ${CLAUDE_CODE_BRIDGE_SESSION_ID:-}" \
  -H "X-Harness-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-}" \
  --data-binary @- \
  "http://127.0.0.1:$PORT/hook/$EVENT" 2>/dev/null) || exit 0

# Only emit something that actually looks like hook JSON. Anything else (an
# error page, a truncated body) is safer left unsaid.
case "$RESPONSE" in
  '{'*) printf '%s' "$RESPONSE" ;;
  *) : ;;
esac

exit 0
