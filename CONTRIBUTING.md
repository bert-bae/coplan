# Contributing to Coplan

Thanks for helping. Coplan is MIT licensed, and anything you contribute is
released under the same [license](LICENSE).

## Reporting bugs and asking for features

Open an [issue](https://github.com/bert-bae/coplan/issues). For a bug, include:

- what you did, what you expected, and what happened instead
- the output of `./bin/coplan doctor` and `./bin/coplan version`
- which agent and its version (`claude --version`, `codex --version`, or
  Cursor's *About*), your OS and Node.js version
- anything relevant from `~/.claude/cc-harness/daemon.log`

## Setting up a checkout

You need Node.js 20.11 or later and at least one of Claude Code, Codex or
Cursor.

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

In Codex, add the checkout as a marketplace (`codex plugin marketplace add
"$PWD"`, then `codex plugin add coplan@coplan`) and trust its hooks in
`/hooks`. Codex installs a copy, so add it again after a rebuild. In Cursor,
copy the checkout to `~/.cursor/plugins/local/coplan` and reload the window.

The daemon runs whatever was in `dist/` when it started, so after a rebuild
restart it with `./bin/coplan restart` (or `/coplan-restart`). Open tabs
reconnect by themselves.

## Checks

```bash
npm run typecheck
npm run build          # or: npm run build:watch
npm test
npm run check          # all three
```

CI runs the same checks on Node 20 and 22, plus `./bin/coplan doctor` and
`npm audit`.

**`dist/` is committed** so the plugin installs with no build step. Run
`npm run build` and commit the result with your change; CI fails when the
committed `dist/` does not match the source.

## How the code is laid out

- `src/shared/plan.ts`: the plan model, covering publishing, every edit and
  the change log
- `src/shared/architecture.ts`: diagrams as words, meaning the architecture
  rendering and the net difference between two versions of a diagram
- `src/shared/agents.ts`: what differs between Claude Code, Codex and
  Cursor — names, question tools, whether a hook can add to a prompt
- `src/shared/link.ts`: how a session is linked back to in its agent
- `src/daemon/agentHooks.ts`: each agent's hook payloads and answers,
  translated to and from Claude Code's
- `src/daemon`: the singleton server, covering sessions, the plan API,
  rendering for Claude, hooks and housekeeping
- `src/mcp`: the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui`: the browser client (React, React Flow, dagre). The canvas is
  `components/FlowCanvas.tsx` with its boxes, arrows and panel in
  `components/flow/`, and layout, arrow geometry and the clipboard in `lib/`
- `bin/coplan-hook-relay.sh`: sh + curl, so no Node process starts per hook;
  `hooks/hooks.json`, `hooks/codex.json` and `hooks/cursor.json` call it
  with each agent's name
- `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`: one manifest
  per agent. Keep their versions in step with `package.json`

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
