<h1 align="center">Coplan</h1>

<p align="center">
  <strong>Plan with Claude Code on a canvas, then follow the build.</strong><br />
  An open-source visual planning workspace for Claude Code.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/bert-bae/coplan/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bert-bae/coplan/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node.js 20.11 or later" src="https://img.shields.io/badge/node-%E2%89%A520.11-339933.svg" />
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg" />
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" /></a>
</p>

---

Coplan gives Claude Code's plan a place to live outside the chat. Claude
publishes its plan: the architecture as diagrams, plus a task breakdown. You
reshape it in the browser. Rearrange and rewire the architecture, record the
decisions on each part, reorganize the tasks and comment on anything. When it
is right you read the exact prompt Claude will get and submit it. The plan
locks, and as Claude builds, the same page follows each task across the board.

Coplan is free and open source under the [MIT license](LICENSE). It runs
entirely on your machine: a small local daemon, a browser UI, and a Claude
Code plugin. No account, no hosted service, and no telemetry.

## Features

- **Architecture you can edit.** Claude's diagrams open laid out along their
  flow on a [React Flow](https://reactflow.dev) canvas. Add, connect, rewire
  and annotate boxes, with keyboard shortcuts, context menus and undo.
- **A task breakdown you can shape.** Nest, split and reorder tasks in an
  outline, link them to the boxes they build, and follow them on a board.
- **Claude reads back what you changed.** It gets the net effect of your edits
  (what is different now, not every drag), with each diagram written out as
  an architecture.
- **Review, then submit.** You see the exact build prompt before it is sent,
  and submitting locks the plan so the design can't drift mid-build.
- **Live progress.** Cards move across the board and boxes fill up as Claude
  marks tasks in progress, done or blocked.
- **Your chat stays the chat.** Coplan never starts a turn or answers for you.
  When Claude asks a question, it links you straight back to that session.

## How it works

Coplan does one thing. It never starts a turn and never answers for you. When
Claude needs a decision it asks in its own chat. Coplan shows the question and
takes you straight to that session, in the Claude desktop app, to answer it.
What Coplan has to say to Claude (the build prompt, or a note that you changed
the plan) rides along with your next message there.

```
 ┌──────────────────── Claude Code session ─────────────────────┐
 │  chat  ◀── you talk to and answer Claude here, and only here │
 │  MCP: harness_plan_publish · _read · _edit · task_update     │
 │  hooks: register the session; notice when Claude is waiting; │
 │         note unread plan changes                             │
 └──────────────┬───────────────────────────────────────────────┘
                │ loopback HTTP
                ▼
 ┌─────────────── coplan daemon (one per user) ─────────────────┐
 │  sessions · plans · change log · static UI · SSE             │
 └──────────────┬──────────────────────────────▲────────────────┘
                │ GET /api/events (SSE)        │ POST …/plan/ops
                ▼                              │
 ┌──────────────── browser UI (React + React Flow) ─────────────┐
 │  Architecture · Tasks · Overview      ──▶ "Answer in Claude" │
 └──────────────────────────────────────────────────────────────┘
```

## Install

You need [Claude Code](https://code.claude.com), Node.js 20.11 or later,
`sh` and `curl`. The Claude desktop app is optional; it is where *Answer in
Claude* links open.

### From GitHub

`dist/` is committed, so the plugin installs with no build step:

```bash
claude plugin marketplace add bert-bae/coplan
```

```bash
claude plugin install coplan@coplan --scope user
```

Or, from inside a Claude Code session, run `/plugin marketplace add
bert-bae/coplan` and then `/plugin install coplan@coplan`.

### From source

```bash
git clone https://github.com/bert-bae/coplan.git
```

```bash
cd coplan && npm install && npm run build
```

Then load the plugin for a single session:

```bash
claude --plugin-dir /path/to/coplan
```

Or install it permanently from your clone:

```bash
claude plugin marketplace add /path/to/coplan
```

```bash
claude plugin install coplan@coplan --scope user
```

Verify the wiring against your installed CLI:

```bash
./bin/coplan doctor
```

> **Coming from cc-harness?** Coplan was previously called cc-harness. The
> slash commands and CLI are now `/coplan*` and `coplan`; the MCP tools and
> the data directory keep their old names (`harness_plan_*`,
> `~/.claude/cc-harness`), so existing plans and configuration carry over.

## Use

In any session with the plugin enabled:

- `/coplan <task>`: Claude investigates, then publishes a plan to the UI
- `/coplan-open`: open this session's plan in the browser
- `/coplan-doctor`: check the wiring
- `/coplan-restart`: restart the daemon after a rebuild

`./bin/coplan status` lists every session and where its plan stands;
`./bin/coplan open` opens the UI. The UI does not open itself unless you set
`autoOpen`.

## The loop

1. **Claude publishes.** `/coplan add a cache to the orders API` — Claude
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
5. **You submit it.** From the Architecture view, *Review & submit plan*
   shows the exact prompt Claude will get — built by the daemon from the
   plan as it stands — and submitting locks the plan.
6. **Claude builds against it.** Your next message in Claude carries the
   prompt. It marks tasks in progress, done or blocked; the cards move across
   the board and the boxes linked to those tasks fill up as it goes.

## Submitting the plan

When the design is right, **Review & submit plan** (top right of the
Architecture view) opens the review:

- **The prompt**, exactly as Claude will get it: what to do, how to report
  progress, anything you add for Claude, what you changed that Claude has not
  read yet, then the whole plan — summary, sections, the architecture and
  the task tree. It is rebuilt as you type, and *Submit* waits until what is
  on screen is what will be sent; a plan that moved on since is refused.
- **Who builds it.** *This Claude session*: your next message in its chat —
  "go" will do — carries the prompt, once, and the board follows each task
  as Claude reports it. *Somewhere else*: the prompt is written for an agent
  without the Coplan tools and copied for you to paste; the plan is locked,
  but nothing reports back, so nothing moves here.

Submitting **locks the plan**. The canvas becomes the final design — boxes
still fill up as the tasks that build them get done — and the Tasks tab
becomes a read-only board where each card glows as it arrives in its new
column. A strip under the header says where the build stands: waiting for
Claude (with *Copy prompt*, in case you would rather paste it), building and
what Claude is on, or built. Claude can still report tasks, add work it
discovers and answer comments; anything that would redesign the plan is
refused, and so is publishing over it until every task is done. *Withdraw*
(before Claude has the prompt) or *Reopen for changes* (after) unlocks it.

A plan too long to hand over in one message — a hook adds about 10,000
characters at most — is sent as the instructions, the summary and the task
list, with Claude told to read the rest with `harness_plan_read`. The review
says when that happens.

## Questions are answered in Claude

Coplan has no question forms and no message box. When Claude stops on
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
| `harness_plan_publish` | Publish the whole plan. Items keep their comments, positions and statuses when their ids survive; refused while you have changes Claude hasn't read, so it can never overwrite your edits blind, and while a submitted plan is still being built. |
| `harness_plan_read` | The plan as text, leading with the net effect of your changes since the last read, with every id Claude needs. Diagrams read as an architecture: the system's shape, each part in flow order with its description, decisions and tasks, then every connection. `changes_only` skips the document and quotes edited text instead. |
| `harness_plan_edit` | A batch of targeted edits — sections, diagrams, tasks, moves, comment replies — applied all or nothing. Once the plan is submitted, only task edits and comment replies. |
| `harness_task_update` | Mark a task in progress, done or blocked, with a one-line note. |

The hooks answer immediately and never hold a turn. They register the
session, keep its working/idle/ended state, notice when Claude is waiting on
you (`PreToolUse`/`PostToolUse` for `AskUserQuestion`, `Notification`,
`Stop`), read the session's link from its environment, and add context to
your next prompt: the build prompt, once, after you submit the plan; or — if
you changed the plan since Claude last read it — one line saying so.

## Housekeeping

The rail's footer holds the two actions that belong to Coplan itself.

**Restart.** The daemon runs whatever was in `dist/` when it started.
Restarting hands the successor the port *and* the token, so open tabs
reconnect by themselves. `coplan restart` and `/coplan-restart` do the same.

**Clean up.** Session directories under `~/.claude/cc-harness` outlive their
session by design, so a `--resume` still finds its plan. The panel reports what
could go and removes only what you tick:

| Group | What it is |
| --- | --- |
| Finished sessions | Saved plans the daemon no longer lists, untouched for over a day |
| Interrupted writes | `.state.*.tmp` files from a daemon killed mid-save |
| Daemon log | The older part of `daemon.log`, trimmed rather than deleted |
| Stale lock file | An address left behind by a process that is gone |

Nothing the daemon is holding is ever offered up. `coplan clean` does the
same from a terminal, with `--dry-run` to only list.

## Configuration

`~/.claude/cc-harness/config.json`, overridden per repo by
`.claude/harness.json`. See [docs/CONFIG.md](docs/CONFIG.md).

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
covers setting up a checkout, the checks CI runs, and how the code is laid
out. The short version:

```bash
npm install
```

```bash
npm run check          # typecheck, build and test
```

Commit the rebuilt `dist/` with your change; CI fails if it is out of date.

## License

[MIT](LICENSE) © Elbert B.
