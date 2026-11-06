#!/bin/sh
# Coplan setup: build this clone, install it in your agents (Claude Code,
# Codex, Cursor), and walk through its settings. Run it again after
# `git pull` to update.
#
#   ./setup.sh [--yes] [--agents claude,codex,cursor|none]
#
# The build needs Node.js 20.11 or later and pnpm (or Node's corepack, or
# npx, to provide it). Everything after the build is `coplan setup`.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

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

# pnpm: the one on the PATH, else corepack's, else npx's. Corepack is tried
# first and checked, since one bundled with an older Node can fail to fetch
# the pnpm this repository pins.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1 && (cd "$ROOT" && corepack pnpm --version) >/dev/null 2>&1; then
  PNPM="corepack pnpm"
elif command -v npx >/dev/null 2>&1; then
  PNPM="npx --yes pnpm@10"
else
  die "pnpm is needed to build Coplan: https://pnpm.io (or Node's corepack, which provides it)."
fi

echo "Building Coplan with $PNPM: the first build fetches about 115 MB of build-time packages, kept in this clone."
# The packages, then the build, each on its own: the build is not left to
# install's `prepare` script, which an ignore-scripts setting would skip.
# node_modules here is only the build's, so when pnpm wants it rebuilt (its
# store moved, say) it may, rather than stop to ask, which it cannot do
# without a terminal (--yes, or run from an agent).
# Run in the clone, from wherever you are: a repository path you give the
# setup later is read from where you ran it.
# shellcheck disable=SC2086
(cd "$ROOT" && $PNPM install --frozen-lockfile --ignore-scripts --config.confirm-modules-purge=false) \
  || die "installing the build's packages failed; the lines above say why."
(cd "$ROOT" && node scripts/build.mjs) || die "the build failed; the lines above say why."

# ${1+"$@"}: an empty "$@" is an unbound variable to set -u in older shells,
# macOS's /bin/sh among them.
exec node "$ROOT/dist/cli/main.js" setup ${1+"$@"}
