---
name: coplan-setup
description: Build the Coplan plugin after installing or updating it
---

Coplan's build output is not in its repository, so a fresh install (or an
update) has to build it once. Install its dependencies with pnpm in the
plugin's own directory — `pnpm install` builds it — and confirm the CLI runs.
Use pnpm if it is installed, and Node's corepack (which provides the pinned
pnpm) if not:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && if command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile; else COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile; fi && ./bin/coplan version
```

If the path comes out empty (not every agent fills it in), use
`${CURSOR_PLUGIN_ROOT}` in Cursor; failing that, the plugin's folder is the
one that holds this command's `commands/` folder — the same one the
`coplan` skill lives two levels below.

It needs Node.js 20.11 or later. If neither pnpm nor corepack is available
(corepack is not bundled with every Node.js release), run it with
`npx --yes pnpm@10 install --frozen-lockfile` instead. If it fails, quote the
failing lines and say what they mean (a missing or old Node.js is the usual
cause).

When it succeeds, tell the user in two lines that Coplan is built, and that
they should **restart their agent** (or start a new session) so the plugin's MCP server and hooks start
from the build — then run `/coplan-doctor` to check the wiring.
