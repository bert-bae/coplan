#!/bin/sh
# Coplan setup: build this clone, install it in your agents (Claude Code,
# Codex, Cursor), and walk through its settings. Run it again after
# `git pull` to update.
#
#   ./setup.sh [--yes] [--agents claude,codex,cursor|none]
#
# The build needs Node.js 20.11 or later and pnpm (or Node's corepack, which
# provides it). Everything after the build is `coplan setup`.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

die() {
  printf 'setup: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
usage: ./setup.sh [--yes] [--agents claude,codex,cursor|none]

Builds Coplan, installs it in your agents, and walks through its settings.
  --yes          ask nothing: install in every agent found, keep the settings
  --agents LIST  install in these agents only, without asking which
EOF
    exit 0
    ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js 20.11 or later is needed, and there is no node on your PATH: https://nodejs.org"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' \
  || die "Node.js 20.11 or later is needed; this is $(node --version)."

if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  PNPM="corepack pnpm"
elif command -v npx >/dev/null 2>&1; then
  PNPM="npx --yes pnpm@10"
else
  die "pnpm is needed to build Coplan: https://pnpm.io (or Node's corepack, which provides it)."
fi

echo "Building Coplan with $PNPM: the first build fetches about 115 MB of build-time packages, kept in this clone."
# Split on purpose: PNPM is a command and its arguments.
# shellcheck disable=SC2086
$PNPM install --frozen-lockfile || die "the build failed; the lines above say why."

exec node "$ROOT/dist/cli/main.js" setup "$@"
