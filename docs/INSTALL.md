# Installing Coplan

Coplan is not listed in Anthropic's, OpenAI's or Cursor's plugin
directories. You install it from a clone of this repository with
`./setup.sh`. The [README](../README.md#install) has the short version; this
page has the rest.

## What you need

- **Node.js 20.11 or later.** The build uses pnpm. If you don't have it, the
  setup uses the pnpm Node's corepack provides, or npx's.
- **git**, **sh** and **curl**. The hooks reach Coplan with curl.
- **Claude Code, Codex or Cursor.** Install Coplan in each agent you use:
  they share one daemon and one page, and the session list says which agent
  each session runs in.
- **Linux or macOS.** On Windows, run your agent in WSL: the hooks are a
  POSIX shell script. From WSL, links open in your Windows browser.

The Claude desktop app is optional: *Answer in Claude* links open there.

## Install

```bash
git clone https://github.com/bert-bae/coplan.git
```

```bash
cd coplan && ./setup.sh
```

The setup:

1. **Builds Coplan** in the clone. The first build fetches about 115 MB of
   build-time packages, kept in the clone. What the build prints goes to
   `setup.log`, and is shown only if it fails.
2. **Stages what runs** in `.plugin/` in the clone, about 5 MB. That folder
   is what your agents install.
3. **Installs Coplan in the agents it finds**, once you say yes. Say no to
   pick some of them.

   | Agent | How |
   | --- | --- |
   | Claude Code | `claude plugin marketplace add <clone>/.plugin`, then `claude plugin install coplan@coplan --scope user`. Claude Code runs Coplan from `.plugin/`, so keep the clone where it is. |
   | Codex | `codex plugin marketplace add <clone>/.plugin`, then `codex plugin add coplan@coplan`, which installs a copy. |
   | Cursor | Copies `.plugin/` to `~/.cursor/plugins/local/coplan`. |

4. **Offers to adjust a few settings.** The default is no; see
   [Settings](#settings).
5. **Restarts Coplan's daemon** on the new build, if one is running. Open
   tabs reconnect by themselves.

| Option | What it does |
| --- | --- |
| `--yes` | Ask nothing: install in every agent found, and leave the settings as they are |
| `--agents claude,codex,cursor` | Install in these agents, without asking. `none` installs in none |
| `--uninstall` | Take Coplan out again; see [Removing it](#removing-it) |

## After installing

- **Claude Code:** start a new session (or run `/reload-plugins`), then
  `/coplan <task>`.
- **Codex:** open `/hooks`, trust Coplan's hooks, start a new thread, then
  `$coplan <task>`. Codex holds a plugin's hooks until you review them, and
  asks again after each update. Until you do, Coplan's tools answer that no
  session is registered.
- **Cursor:** run *Developer: Reload Window*, then `/coplan <task>`.

`/coplan-doctor` checks the wiring end to end. In Codex, ask it to run the
Coplan doctor.

## Settings

Coplan works with its defaults. Answer yes to *Adjust settings now?* and the
setup asks for the ones people most often change:

- **Your build defaults**, for every repository: who reviews each task, how
  many tasks are built at once, and how pull requests are opened. They go in
  `~/.claude/cc-harness/coplan.json`.
- **Whether the plan opens in your browser by itself** when the agent
  publishes one. This goes in `~/.claude/cc-harness/config.json`.
- **A repository's checks**, if you give it a repository's path: the
  commands each task runs (typecheck, lint, tests), proposed from that
  repository's scripts. They go in `.coplan/config.json` in the repository.
  Commit the file; `/coplan-init` in that repository checks it against your
  CI.

Each question starts from what is set now, and only what you change is
written. A file you wrote comments in is copied to `<file>.bak` before it is
rewritten, since the rewrite drops them. Every other setting is in
[CONFIG.md](CONFIG.md), to set by hand.

## Updating

```bash
git pull && ./setup.sh
```

The setup rebuilds Coplan, installs the new build in your agents, and
restarts the daemon on it. Codex asks you to trust the hooks again. If you
moved the clone, run `./setup.sh` again from its new place.

## Removing it

```bash
./setup.sh --uninstall
```

This stops the daemon, takes Coplan out of every agent it is in, and removes
`.plugin/`. It then asks whether to delete your saved plans and settings
(`~/.claude/cc-harness`, or wherever `CC_HARNESS_HOME` points); the default
is to keep them. Delete the clone afterwards. A repository's
`.coplan/config.json` is yours: keep it or delete it.

By hand, the same is:

- Claude Code: `claude plugin uninstall coplan@coplan`, then
  `claude plugin marketplace remove coplan`.
- Codex: `codex plugin remove coplan@coplan`, then
  `codex plugin marketplace remove coplan`.
- Cursor: delete `~/.cursor/plugins/local/coplan`.

## If something is wrong

- **Run `/coplan-doctor`.** It checks Node and curl, the config files, the
  daemon's version, and a whole round trip with real hook payloads.
- **The build failed:** `setup.log` in the clone has all of its output. An
  old or missing Node.js is the usual cause.
- **In Codex, Coplan's tools say no session is registered:** trust Coplan's
  hooks in `/hooks`, then start a new thread.
- **"Coplan is not built":** a checkout you load directly (for example with
  `claude --plugin-dir`) has to be built once. Run `./setup.sh` in it, or
  `pnpm install` to only build it.

## Moving from an older install

- **Installed Coplan straight from GitHub?** If you ran
  `claude plugin marketplace add bert-bae/coplan` (or the Codex
  equivalent), running `./setup.sh` from a clone moves the `coplan`
  marketplace to the clone. You don't need to remove anything first.
- **Coming from cc-harness?** Coplan was previously called cc-harness. The
  slash commands and CLI are now `/coplan*` and `coplan`; the MCP tools and
  the data directory keep their old names (`harness_plan_*`,
  `~/.claude/cc-harness`), so existing plans and configuration carry over.
