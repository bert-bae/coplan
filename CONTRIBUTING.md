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

You need Node.js 20.11 or later, [pnpm](https://pnpm.io) 10 (`corepack enable
pnpm` provides the version this repository pins) and at least one of Claude
Code, Codex or Cursor.

```bash
git clone https://github.com/bert-bae/coplan.git
```

```bash
cd coplan && pnpm install           # installs, and builds dist/
```

Load your checkout instead of an installed copy:

```bash
claude --plugin-dir "$PWD"
```

Codex and Cursor take a copy of a plugin, so install your build in them with
`./setup.sh --agents codex,cursor`, and run it again after a rebuild. In
Codex, trust the hooks in `/hooks` again each time. Add `--yes` to skip the
questions.

The daemon runs whatever was in `dist/` when it started, so after a rebuild
restart it with `./bin/coplan restart` (or `/coplan-restart`). Open tabs
reconnect by themselves.

## Checks

```bash
pnpm typecheck
pnpm build             # or: pnpm build:watch
pnpm test
pnpm check             # all three
```

CI runs the same checks on Linux and macOS with Node 22, and on Node
20.11.0 (the oldest the plugin supports) runs every test that needs no
browser (`pnpm test:runtime`: jsdom needs a newer Node), plus
`./bin/coplan doctor` and
`pnpm audit`; it also runs `shellcheck` on the shell scripts and
`claude plugin validate .`. A version bump that reaches `main` is tagged and
released from its CHANGELOG.md section. The repository's own [`.coplan/config.json`](.coplan/config.json)
lists them per stage, so `./bin/coplan check review` runs what a change needs.

**`dist/` is not committed.** It is build output: `pnpm install` builds it (the
`prepare` script), and `pnpm build` rebuilds it. People install Coplan with
[`./setup.sh`](setup.sh), which builds it and installs `.plugin/`, a copy of
what runs, in their agents. The staged copy holds the paths in `STAGED` in
[`src/cli/setup.ts`](src/cli/setup.ts): a new file the plugin needs at run time
goes there too, and `src/test/setup.test.ts` fails when a manifest, hook or
MCP config names one that is missing.

## How the code is laid out

- `src/shared/plan.ts`: the plan model, covering publishing, every edit and
  the change log
- `src/shared/architecture.ts`: diagrams as words, meaning the architecture
  rendering and the net difference between two versions of a diagram
- `src/shared/build.ts`: the build as a graph — dependencies, readiness,
  build steps, branches and how they stack, review modes and settings
- `src/shared/project.ts`: a repository's `.coplan/config.json` — the check
  hooks per stage and the build's defaults
- `src/shared/agents.ts`: what differs between Claude Code, Codex and
  Cursor — names, question tools, whether a hook can add to a prompt
- `src/shared/link.ts`: how a session is linked back to in its agent
- `src/daemon/agentHooks.ts`: each agent's hook payloads and answers,
  translated to and from Claude Code's
- `src/daemon`: the singleton server, covering sessions, the plan API,
  rendering for Claude (`render.ts` for the read-back, the prompts and the
  plan's Markdown export,
  `brief.ts` for what is next and one task's brief), hooks and housekeeping
- `src/cli`: the `coplan` CLI, including `check` (runs a stage's hooks) and
  `init` (writes a starting `.coplan/config.json`)
- `skills/`: what Claude is taught — `coplan` (the design and the task list),
  `coplan-build` (running a build) and `iric` (one task's cycle)
- `src/mcp`: the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui`: the browser client (React, React Flow, dagre). The canvas is
  `components/FlowCanvas.tsx` with its boxes, arrows and panel in
  `components/flow/`, and layout, arrow geometry and the clipboard in `lib/`
- `bin/coplan-hook-relay.sh`: sh + curl, so no Node process starts per hook;
  `hooks/hooks.json`, `hooks/codex.json` and `hooks/cursor.json` call it
  with each agent's name
- `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`: one manifest
  per agent. Keep their versions in step with `package.json`
- `scripts/demo/`: the demo plans behind the README's screenshots, and the
  script that takes them (below)

## Screenshots and the README's numbers

The README's screenshots come from demo plans seeded into a daemon of their
own, so taking them again never touches your sessions. After a change to the
page, build and run:

```bash
pnpm build && node scripts/demo/screenshots.mjs --repos /tmp/code
```

It needs Playwright with Chromium (not a dependency here: install it
globally). `--only board,report` takes just those; Pillow, if Python has it,
reduces each image to 256 colours. The page header shows each demo
repository's path, which is why a short `--repos` reads better.

The README's [Resource footprint](README.md#resource-footprint) and
[What it installs](README.md#what-it-installs) describe this code: if you
change a hook, a tool, a skill, what is stored, or anything that moves those
numbers, update them in the same pull request.

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
sure `pnpm check` passes.
