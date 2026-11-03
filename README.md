# cc-harness

A visual planning workspace for Claude Code. Claude publishes its plan —
architecture diagrams, a task breakdown, the questions it needs answered —
and you read it, reorganize it, comment on it and answer it in the browser.
When you're done, you tell Claude in its own chat, and it reads back exactly
what you changed.

The problem it solves: a plan written into a chat is a wall of prose. You can't
see the architecture, you can't drag a task under another one, and you can
only answer five questions by writing an essay that quotes each of them. The
harness gives the plan a shape you can work with, then hands it back to the
conversation.

It does one thing. The harness never talks to Claude, never waits for you,
and never holds a turn open. Every exchange happens in Claude's chat; the
harness is where the plan lives.

```
 ┌──────────────────── Claude Code session ─────────────────────┐
 │  chat  ◀── you talk to Claude here, and only here            │
 │  MCP: harness_plan_publish · _read · _edit · task_update     │
 │  hooks: register the session; note unread plan changes       │
 └──────────────┬───────────────────────────────────────────────┘
                │ loopback HTTP
                ▼
 ┌──────────────── cc-harnessd (one per user) ──────────────────┐
 │  sessions · plans · change log · static UI · SSE             │
 └──────────────┬──────────────────────────────▲────────────────┘
                │ GET /api/events (SSE)        │ POST …/plan/ops
                ▼                              │
 ┌──────────────── browser UI (React + React Flow) ─────────────┐
 │  Overview · Diagrams · Tasks · Questions · Activity          │
 └──────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install
npm run build          # writes dist/, which the plugin loads directly
```

`dist/` is committed, so installing the plugin needs no build step of its own.

Then load the plugin. For a session at a time:

```bash
claude --plugin-dir /path/to/cc-ui-harness
```

Or permanently, via a local marketplace:

```bash
claude plugin marketplace add /path/to/cc-ui-harness
```

```bash
claude plugin install cc-harness@cc-harness-local --scope user
```

Verify the wiring against your installed CLI:

```bash
./bin/harness doctor
```

## Use

In any session with the plugin enabled:

- `/harness <task>` — Claude investigates, then publishes a plan to the UI
- `/harness-open` — open this session's plan in the browser
- `/harness-doctor` — check the wiring
- `/harness-restart` — restart the daemon after a rebuild

`./bin/harness status` lists every session and where its plan stands;
`./bin/harness open` opens the UI. The UI does not open itself unless you set
`autoOpen`.

## The loop

1. **Claude publishes.** `/harness add a cache to the orders API` — Claude
   reads the code and calls `harness_plan_publish`, then tells you in chat that
   the plan is ready.
2. **You work the plan.** In the browser, answer its questions, drag tasks
   into the order you want, nest and split them, redraw the architecture, and
   leave comments on anything. Every edit is saved at once and recorded in the
   plan's change log as yours.
3. **You hand it back in chat.** The header shows how many of your changes
   Claude hasn't read, and *Copy message for Claude* puts a ready-made
   "read the plan" message on your clipboard. If you just type in chat,
   the next prompt carries a one-line note that the plan changed.
4. **Claude reads it back.** `harness_plan_read` leads with exactly what you
   did since it last looked: your answers, your moves, your comments. It
   adjusts, replies in your comment threads, answers questions you asked it,
   and tells you in chat what changed. Repeat until it's settled.
5. **Claude builds against it.** As it works it marks tasks in progress, done
   or blocked, so the Tasks board shows where it is.

## The views

**Overview.** The plan as a document: a summary, then sections (context,
architecture, risks…) you can edit in place, reorder and comment on. Four
tiles across the top give the state at a glance — task progress, open
questions, diagrams, open comments — and each opens its tab.

**Diagrams.** Each diagram is a [React Flow](https://reactflow.dev) canvas.
Claude writes nodes and edges without coordinates, and dagre lays them out;
you drag boxes where you want them, draw arrows between handles, select a box
or arrow to relabel it or change its kind, and press Backspace to delete.
*Tidy layout* re-lays the whole diagram, the direction toggle flips it between
left-to-right and top-to-bottom, and *Full screen* gives it the window. Box
kinds — component, service, datastore, queue, external, actor, note — have
their own shape and colour. Your edits reach Claude in words: *connected
Cache warmer → Postgres*, *added "Jobs"*, *rearranged 3 nodes*.

**Tasks.** The breakdown, two ways:

- *Outline* is for shaping it. Rows nest to any depth with outline numbers.
  Drag a row onto another to nest it, or onto its top or bottom edge to place
  it beside; or, with a row focused, Alt+↑/↓ to reorder, Alt+→ to nest under
  the row above, Alt+← to move out a level. Click a status dot to move it
  along; open a row for its detail, expected files, status note, linked
  questions and comments.
- *Board* is for following it: every leaf task in a To do / In progress /
  Blocked / Done column, with its parent path. Drag between columns, or use
  the status menu on the card.

Progress counts leaf tasks only — a parent is a heading over its subtasks.

**Questions.** Claude's open decisions first, each with its options as
choices (single or multi-select) and room for your own words. Saving an
answer records it on the plan; nothing is sent. You can ask Claude questions
here too, and its answers land on the same card.

**Activity.** The change log, newest first, with a line marking how far
Claude has read. Everything of yours above the line is what it hasn't seen.

*As Claude sees it*, in the header, shows the plan exactly as
`harness_plan_read` will return it — opening it does not count as Claude
reading.

## What Claude gets

Four tools, none of which waits on you:

| Tool | What it does |
| --- | --- |
| `harness_plan_publish` | Publish the whole plan. Items keep their comments and answers when their ids survive; refused while you have changes Claude hasn't read, so it can never overwrite your edits blind. |
| `harness_plan_read` | The plan as text, leading with your changes since the last read, with every id Claude needs. `changes_only` skips the document. |
| `harness_plan_edit` | A batch of targeted edits — sections, diagrams, tasks, moves, questions, answers, replies — applied all or nothing. |
| `harness_task_update` | Mark a task in progress, done or blocked, with a one-line note. |

The browser and Claude edit through the same operations, so the change log is
written in one place whoever made the change. Ids are short and never reused
(`t4`, `q2`, `d1`, `c3`), so a comment can't end up on a different item.

The hooks do three things and answer immediately: register the session on
`SessionStart`, keep its working/idle/ended state for the rail, and — if you
changed the plan since Claude last read it — add one line to your next chat
prompt saying so. Turn that off with `promptNotice: false`.

## Housekeeping

The rail's footer holds the two actions that belong to the harness itself.

**Restart.** The daemon runs whatever was in `dist/` when it started.
Restarting hands the successor the port *and* the token, so open tabs
reconnect by themselves. `harness restart` and `/harness-restart` do the same.

**Clean up.** Session directories under `~/.claude/cc-harness` outlive their
session by design, so a `--resume` still finds its plan. The panel reports what
could go and removes only what you tick:

| Group | What it is |
| --- | --- |
| Finished sessions | Saved plans the daemon no longer lists, untouched for over a day |
| Interrupted writes | `.state.*.tmp` files from a daemon killed mid-save |
| Daemon log | The older part of `daemon.log`, trimmed rather than deleted |
| Stale lock file | An address left behind by a process that is gone |

Nothing the daemon is holding is ever offered up. `harness clean` does the
same from a terminal, with `--dry-run` to only list.

## Configuration

`~/.claude/cc-harness/config.json`, overridden per repo by
`.claude/harness.json`. See [docs/CONFIG.md](docs/CONFIG.md).

## Development

```bash
npm run typecheck
npm run build          # or: npm run build:watch
npm test
npm run check          # all three
```

- `src/shared/plan.ts` — the plan model: publishing, every edit, the change log
- `src/daemon` — the singleton server: sessions, the plan API, rendering for
  Claude, hooks, housekeeping
- `src/mcp` — the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui` — the browser client (React, React Flow, dagre)
- `bin/hook-relay.sh` — sh + curl, so no Node process starts per hook

The daemon, the MCP server and the CLI have no runtime dependencies. The
browser bundle carries React and React Flow, compiled once, and React Flow's
stylesheet is copied beside it.
