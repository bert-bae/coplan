# Contributing to Coplan

Thanks for helping. Coplan is MIT licensed, and anything you contribute is
released under the same [license](LICENSE).

## Reporting bugs and asking for features

Open an [issue](https://github.com/bert-bae/coplan/issues). For a bug, include:

- what you did, what you expected, and what happened instead
- the output of `./bin/harness doctor` and `./bin/harness version`
- your Claude Code version (`claude --version`), OS and Node.js version
- anything relevant from `~/.claude/cc-harness/daemon.log`

## Setting up a checkout

You need Node.js 20.11 or later and Claude Code.

```bash
git clone https://github.com/bert-bae/coplan.git
```

```bash
cd coplan && npm install && npm run build
```

Load your checkout instead of an installed copy:

```bash
claude --plugin-dir "$PWD"
```

The daemon runs whatever was in `dist/` when it started, so after a rebuild
restart it with `./bin/harness restart` (or `/harness-restart`). Open tabs
reconnect by themselves.

## Checks

```bash
npm run typecheck
npm run build          # or: npm run build:watch
npm test
npm run check          # all three
```

CI runs the same checks on Node 20 and 22, plus `./bin/harness doctor` and
`npm audit`.

**`dist/` is committed** so the plugin installs with no build step. Run
`npm run build` and commit the result with your change; CI fails when the
committed `dist/` does not match the source.

## How the code is laid out

- `src/shared/plan.ts`: the plan model, covering publishing, every edit and
  the change log
- `src/shared/architecture.ts`: diagrams as words, meaning the architecture
  rendering and the net difference between two versions of a diagram
- `src/shared/link.ts`: how a session is linked back to in Claude
- `src/daemon`: the singleton server, covering sessions, the plan API,
  rendering for Claude, hooks and housekeeping
- `src/mcp`: the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui`: the browser client (React, React Flow, dagre). The canvas is
  `components/FlowCanvas.tsx` with its boxes, arrows and panel in
  `components/flow/`, and layout, arrow geometry and the clipboard in `lib/`
- `bin/hook-relay.sh`: sh + curl, so no Node process starts per hook

## Ground rules

- **No runtime dependencies** in the daemon, the MCP server or the CLI. The
  browser bundle carries React and React Flow, compiled once.
- **Hooks never hold a turn.** They answer immediately; Coplan never starts a
  turn or answers for the user.
- **Never overwrite the user's edits blind.** `harness_plan_publish` is refused
  while the user has changes Claude hasn't read.
- Add or update tests in `src/test` for behaviour you change.
- Add a line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice.

## Pull requests

Keep a pull request to one change, describe what it does and why, and make
sure `npm run check` passes with `dist/` rebuilt.
