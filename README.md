# cc-harness

A visual planning workspace for Claude Code, and a way to follow Claude's
progress through the plan. Claude publishes its plan — the architecture as
diagrams, and a task breakdown — and you reshape it in the browser: rearrange
and rewire the architecture, record the decisions on each part, reorganize the
tasks, comment on anything. As Claude builds, the same page shows where it is.

It does one thing. The harness never talks to Claude and never answers it.
When Claude needs a decision it asks in its own chat; the harness shows the
question and takes you straight to that session — in the Claude desktop app —
to answer it.

```
 ┌──────────────────── Claude Code session ─────────────────────┐
 │  chat  ◀── you talk to and answer Claude here, and only here │
 │  MCP: harness_plan_publish · _read · _edit · task_update     │
 │  hooks: register the session; notice when Claude is waiting; │
 │         note unread plan changes                             │
 └──────────────┬───────────────────────────────────────────────┘
                │ loopback HTTP
                ▼
 ┌──────────────── cc-harnessd (one per user) ──────────────────┐
 │  sessions · plans · change log · static UI · SSE             │
 └──────────────┬──────────────────────────────▲────────────────┘
                │ GET /api/events (SSE)        │ POST …/plan/ops
                ▼                              │
 ┌──────────────── browser UI (React + React Flow) ─────────────┐
 │  Architecture · Tasks · Overview      ──▶ "Answer in Claude"  │
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
   reads the code, calls `harness_plan_publish`, and asks what it needs decided
   with `AskUserQuestion` in chat.
2. **You shape the plan.** In the browser, rearrange and rewire the
   architecture, write down the decisions on each box, drag tasks into the
   order you want, nest and split them, and comment on anything. Every edit is
   saved at once and recorded in the plan's change log as yours.
3. **You hand it back in chat.** The header says when Claude hasn't read
   your changes and opens the session in Claude. If you just type in chat,
   the next prompt carries a one-line note saying where the plan changed.
4. **Claude reads it back.** `harness_plan_read` leads with the net effect of
   your edits since it last looked — what is different now, not each step
   you took, and never where you dragged boxes — then the plan, with each
   diagram written out as an architecture. It adjusts and replies in your
   comment threads.
5. **Claude builds against it.** It marks tasks in progress, done or blocked,
   and boxes linked to those tasks fill up as it goes.

## Questions are answered in Claude

The harness has no question forms and no message box. When Claude stops on
you — an `AskUserQuestion`, a permission prompt, an idle prompt, or a turn
that ends on a question — the page shows a banner with what is being asked,
the session moves to *Waiting on you* at the top of the rail, and the tab
title changes. **Answer in Claude** opens the session:

| Where the session runs | Link |
| --- | --- |
| Cloud (claude.ai/code) | `claude://claude.ai/code/session_…` for the desktop app, plus a web link |
| Local, with Remote Control on | the same, from the Remote Control session id |
| Local, without Remote Control | no documented link exists — the banner says where to answer, and that `/remote-control` turns it into a link |

The banner clears as soon as you answer in Claude. Set `openClaudeOnQuestion`
to have a local Remote Control session open itself in the desktop app the
moment it asks.

## The views

**Architecture.** One diagram at a time fills the view: a
[React Flow](https://reactflow.dev) canvas taking about 70% of the width, and a
details panel beside it.

*On the canvas.* A diagram Claude publishes opens laid out along its flow
(top to bottom when it is long and narrow), with room for every arrow's
label, arrows routed around the boxes they pass, and boxes with no
connections on a shelf to one side. *Tidy layout* lays it out again and the
direction toggle flips it.

| To | Do |
| --- | --- |
| Add a box | *+ Box*, double-click or right-click empty canvas, or drag an arrow out of a box into space |
| Add the next box along the flow | Select a box, then **Tab** (after it), **⇧Tab** (before it) or **Enter** (beside it, fed by the same boxes) |
| Connect two boxes | Drag from any edge of one onto the other |
| Move an arrow's end | Select or hover the arrow and drag the grip at that end onto another box |
| Put a box into an arrow | Drop an unconnected box on the arrow, or right-click the arrow → *Insert a box here* |
| Rename a box or an arrow | Start typing on a selected box, or double-click (F2) |
| See what a box connects to | Hover or select it: what it sends to, what sends to it and two-way links light up in their own colours, arrows flow in their direction, the rest fades. Hold **Alt** for two steps out |
| See what a box is | Hover its ⓘ: description, decisions, tasks, connections |
| Everything you can do to it | Right-click it, or **⇧F10** |
| Copy, cut, paste, duplicate | ⌘/Ctrl + C, X, V, D — across diagrams and tabs |
| Undo, redo | ⌘/Ctrl+Z, ⇧⌘/Ctrl+Z — or the toolbar's ↶ ↷ |
| Delete, keeping the flow | **Alt+⌫**: A→B→C without B becomes A→C |
| Fit everything / zoom to the selection | **⇧1** / **⇧2**; Space-drag pans |
| See every shortcut | **?** |

Undo covers your own edits on the canvas. If Claude (or another tab) changes
the diagram, history up to that point is dropped rather than letting an undo
quietly revert their change, and the page says so.

*In the panel.* Select a box and the panel edits it: its name and the few
words shown on it (inputs), its **kind**, a **description** of what it does
and how others talk to it (a textarea that grows as you write), **notes and
decisions** (markdown — what was decided and why), the **tasks that build
it**, and its **connections**, which you can add and remove there. Select an
arrow to say what flows along it, reverse or re-point it, and draw it dashed
or with heads at both ends or none. Select several boxes to change their kind
at once. With nothing selected the panel describes the diagram, holds its
comments, and copies it as Markdown — the same text Claude reads.

Boxes linked to tasks show those tasks' progress, so the picture doubles as
a progress map. Your edits reach Claude as the design they produced: *Added
Rate limiter — service*, *Connected API gateway → Rate limiter: check*,
*Changed Redis: description edited*.

**Tasks.** The breakdown, two ways:

- *Outline* is for shaping it. Rows nest to any depth with outline numbers.
  Drag a row onto another to nest it, or onto its top or bottom edge to place
  it beside; or, with a row focused, Alt+↑/↓ to reorder, Alt+→ to nest under
  the row above, Alt+← to move out a level. Each row shows the boxes it
  builds; click one to see it on the canvas.
- *Board* is for following Claude: every leaf task in a To do / In progress /
  Blocked / Done column.

**Overview.** The summary, supporting sections, and tiles for progress, what
Claude is on right now, diagrams and open comments.

**The session list** groups sessions by project, lifts the ones waiting on
you to the top, and shows each one's current task. Fold it to a rail of
initials with the ☰ button or `[` to give the plan the width.

*As Claude sees it*, in the header, shows the plan exactly as
`harness_plan_read` returns it.

## What Claude gets

Four tools, none of which waits on you or asks you anything:

| Tool | What it does |
| --- | --- |
| `harness_plan_publish` | Publish the whole plan. Items keep their comments, positions and statuses when their ids survive; refused while you have changes Claude hasn't read, so it can never overwrite your edits blind. |
| `harness_plan_read` | The plan as text, leading with the net effect of your changes since the last read, with every id Claude needs. Diagrams read as an architecture: the system's shape, each part in flow order with its description, decisions and tasks, then every connection. `changes_only` skips the document and quotes edited text instead. |
| `harness_plan_edit` | A batch of targeted edits — sections, diagrams, tasks, moves, comment replies — applied all or nothing. |
| `harness_task_update` | Mark a task in progress, done or blocked, with a one-line note. |

The hooks answer immediately and never hold a turn. They register the
session, keep its working/idle/ended state, notice when Claude is waiting on
you (`PreToolUse`/`PostToolUse` for `AskUserQuestion`, `Notification`,
`Stop`), read the session's link from its environment, and — if you changed
the plan since Claude last read it — add one line to your next prompt saying
so.

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
- `src/shared/architecture.ts` — diagrams as words: the architecture
  rendering and the net difference between two versions of a diagram
- `src/shared/link.ts` — how a session is linked back to in Claude
- `src/daemon` — the singleton server: sessions, the plan API, rendering for
  Claude, hooks, housekeeping
- `src/mcp` — the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui` — the browser client (React, React Flow, dagre); the canvas is
  `components/FlowCanvas.tsx` with its boxes, arrows and panel in
  `components/flow/`, and layout, arrow geometry and the clipboard in `lib/`
- `bin/hook-relay.sh` — sh + curl, so no Node process starts per hook

The daemon, the MCP server and the CLI have no runtime dependencies. The
browser bundle carries React and React Flow, compiled once, and React Flow's
stylesheet is copied beside it.
