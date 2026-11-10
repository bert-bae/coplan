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
SELF_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd) || SELF_ROOT=
PLUGIN_ROOT_DIR="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-$SELF_ROOT}}}"

PAYLOAD=$(cat)
[ -n "$PAYLOAD" ] || exit 0

# Every tool call's output comes with PostToolUse, and the daemon only needs
# to hear which session's tool finished — that is what clears a question or
# a permission prompt off the board. A huge one (a big file read, a long
# build log) is not worth shipping and parsing, so only the session goes.
# The id is the payload's first one (agents put it first); the shortest
# match up to it, then a plain string, so nothing in the output is taken.
case "$EVENT" in
  PostToolUse|postToolUse)
    if [ "${#PAYLOAD}" -gt 262144 ]; then
      ID_KEY=session_id
      [ "$AGENT" = cursor ] && ID_KEY=conversation_id
      REST=${PAYLOAD#*\"$ID_KEY\"}
      [ "$REST" = "$PAYLOAD" ] && exit 0
      ID=$(printf '%s' "$REST" | sed -n '1s/^[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._:-]*\)".*/\1/p')
      [ -n "$ID" ] || exit 0
      PAYLOAD=$(printf '{"%s":"%s","hook_event_name":"%s"}' "$ID_KEY" "$ID" "$EVENT")
    fi
    ;;
esac

# An installed but unbuilt plugin (`dist/` is not in the repository) has no
# daemon to start and no MCP server: everything would fail silently, and the
# only symptom would be a "connection closed" on the tools. Say so once, at
# the start of the session, in each agent's own format — and nothing else.
if [ -n "$PLUGIN_ROOT_DIR" ] && [ ! -f "$PLUGIN_ROOT_DIR/dist/daemon/main.js" ]; then
  case "$EVENT" in
    SessionStart|sessionStart)
      CONTEXT="Coplan's plugin is installed but not built, so its tools and hooks are off. If the user wants Coplan, tell them to build it: /coplan-setup in Claude Code or Cursor, or ask Codex to set up Coplan (pnpm install in $PLUGIN_ROOT_DIR)."
      CONTEXT=$(printf '%s' "$CONTEXT" | sed 's/\\/\\\\/g; s/"/\\"/g')
      case "$AGENT" in
        claude) printf '{"systemMessage":"Coplan is not built - run /coplan-setup, then start a new session.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$CONTEXT" ;;
        codex) printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$CONTEXT" ;;
        cursor) printf '{"additional_context":"%s"}' "$CONTEXT" ;;
      esac
      ;;
  esac
  exit 0
fi

HOME_DIR="${CC_HARNESS_HOME:-$HOME/.claude/cc-harness}"
LOCK="$HOME_DIR/daemon.json"

# Nothing the harness does waits on the user, so every event is near instant.
# A session's first call, or the first to a daemon just started, may wait on
# it loading: those get longer. Starting the daemon (up to 5s) plus the call
# stays inside the hook's 20-second budget.
case "$EVENT" in
  SessionStart|sessionStart) MAX_TIME=10 ;;
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
  # Its pid may be some other process's by now (after a reboot, say). Where
  # the daemon may need starting, ask it: it answers /health with its pid.
  # Every other event saves the round trip — a dead port fails fast anyway.
  case "$EVENT" in
    SessionStart|sessionStart|UserPromptSubmit|beforeSubmitPrompt)
      HEALTH=$(curl -s --max-time 2 --connect-timeout 1 "http://127.0.0.1:$PORT/health" 2>/dev/null)
      RC=$?
      # Slow to answer (curl's timeout, 28) is a busy daemon, not a dead one:
      # starting another would only see it there and exit.
      [ "$RC" -eq 28 ] && return 0
      case "$HEALTH" in
        *"\"pid\":$PID,"*|*"\"pid\":$PID}"*) ;;
        *) return 1 ;;
      esac
      ;;
  esac
  return 0
}

start_daemon() {
  # The session's first event, and each message the user sends, may start the
  # daemon: one that shut down after a long idle comes back with the next
  # message, so the sign-off it carries is not lost. Every other event in a
  # session that has no daemon simply no-ops.
  case "$EVENT" in
    SessionStart|sessionStart|UserPromptSubmit|beforeSubmitPrompt) ;;
    *) return 1 ;;
  esac
  [ -n "$PLUGIN_ROOT_DIR" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  ENTRY="$PLUGIN_ROOT_DIR/dist/daemon/main.js"
  [ -f "$ENTRY" ] || return 1
  mkdir -p "$HOME_DIR" 2>/dev/null || true
  # A daemon that would not start a moment ago (an old node, a crash on
  # start) will not now: a message the user sends does not wait five seconds
  # on it again. A new session still tries.
  FAILED="$HOME_DIR/start-failed"
  case "$EVENT" in
    UserPromptSubmit|beforeSubmitPrompt)
      [ -n "$(find "$FAILED" -mmin -5 2>/dev/null)" ] && return 1 ;;
  esac
  # Detached into a session of its own, so it outlives the agent that started
  # it. Node does that itself: macOS has no setsid command, and a fallback
  # after `( … &) ||` never runs, since a backgrounded command always succeeds.
  node --input-type=commonjs -e 'require("child_process").spawn(process.execPath, [process.argv[1]], { detached: true, stdio: "ignore" }).unref()' "$ENTRY" >/dev/null 2>&1
  # Waited on by the clock, not by count: where sleep takes no fractions,
  # fifty tries would be fifty seconds.
  DEADLINE=$(( $(date +%s) + 5 ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    sleep 0.1 2>/dev/null || sleep 1
    if read_lock; then
      rm -f "$FAILED" 2>/dev/null
      MAX_TIME=10
      return 0
    fi
  done
  : > "$FAILED" 2>/dev/null
  return 1
}

if ! read_lock; then
  start_daemon || exit 0
fi

# Hooks run inside the session's own environment, which is the only place
# that says where the session lives — and therefore how to link back to it so
# the user can answer the agent there. Remote Control can be switched on
# mid-session, so this goes with every event rather than only SessionStart.
# The token goes to curl in a file the daemon wrote for this user alone: on
# curl's command line, any local user could read it from /proc. A daemon
# from before that file existed gets it on the command line, as it did.
AUTH_FILE="$HOME_DIR/auth.header"
AUTH_LINE=""
# Read with the shell's own builtin, not grep: no other process sees it.
[ -r "$AUTH_FILE" ] && IFS= read -r AUTH_LINE < "$AUTH_FILE" 2>/dev/null
if [ "$AUTH_LINE" = "Authorization: Bearer $TOKEN" ]; then
  AUTH_ARG="@$AUTH_FILE"
else
  AUTH_ARG="Authorization: Bearer $TOKEN"
fi
# When curl gives up, so a daemon too busy to answer in time knows no one
# will read what it says: a prompt it would hand over is kept for the next.
GIVE_UP_AT=$(( $(date +%s) + MAX_TIME ))
RESPONSE=$(printf '%s' "$PAYLOAD" | curl -s -S \
  --max-time "$MAX_TIME" \
  --connect-timeout 2 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "$AUTH_ARG" \
  -H "X-Harness-Agent: $AGENT" \
  -H "X-Harness-Deadline: $GIVE_UP_AT" \
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
