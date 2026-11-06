---
name: coplan-setup
description: Say how to update Coplan or change its settings, or build a checkout loaded directly
---

Coplan is installed from a clone of its repository: `./setup.sh` there
builds it and installs it in the user's agents.
Which case this is depends on the plugin's folder, `${CLAUDE_PLUGIN_ROOT}`.
If the path comes out empty (not every agent fills it in), use
`${CURSOR_PLUGIN_ROOT}` in Cursor; failing that, the plugin's folder is the
one that holds this command's `commands/` folder.

**The folder holds `install.json`:** this is the copy `./setup.sh` installed,
and it is built. Read `install.json` — `clone` names the clone — and run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/coplan" version
```

Then tell the user, in a few lines, which version is installed and that to
update Coplan, add it to another agent, or change its settings, they run this
in a terminal (it is interactive, so do not run it for them):

```bash
cd "<clone>" && git pull && ./setup.sh
```

**No `install.json`:** a checkout loaded directly (for example with
`claude --plugin-dir`). Its build output is not in the repository, so build
it once, in place, with pnpm if it is installed and Node's corepack (which
provides the pinned pnpm) if not:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && if command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile; else COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile; fi && ./bin/coplan version
```

It needs Node.js 20.11 or later. If neither pnpm nor corepack is available
(corepack is not bundled with every Node.js release), run it with
`npx --yes pnpm@10 install --frozen-lockfile` instead. If it fails, quote the
failing lines and say what they mean (a missing or old Node.js is the usual
cause).

When it succeeds, tell the user in two lines that Coplan is built, and that
they should **restart their agent** (or start a new session) so the plugin's
MCP server and hooks start from the build — then run `/coplan-doctor` to
check the wiring. To install it in their agents for good, they run
`./setup.sh` in that checkout.
