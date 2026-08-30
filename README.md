# cc-harness

A live browser UI for a running Claude Code session: watch the plan, the
progress, the diff and the checks — and answer from the UI, with every answer
landing back in the same session.

The problem it solves: inside a Claude Code chat it is hard to see what was
planned, what is done, and what changed, and the only way to give feedback on a
specific line is to describe it in prose. cc-harness puts a review surface in
front of the session and wires it back in.

```
 ┌──────────────── Claude Code session ────────────────┐
 │   hooks (sh + curl relay)         MCP stdio server  │
 └──────────┬─────────────────────────────┬────────────┘
            │ POST /hook/<Event>          │ tools/call
            │ (Stop parks here)           │ (harness_await parks here)
            ▼                             ▼
 ┌──────────────── cc-harnessd (one per user) ─────────────────┐
 │  sessions · stage machine · transcript tailer               │
 │  git diff · gates · checks · ship · static UI · SSE         │
 └──────────┬───────────────────────────────────┬──────────────┘
            │ GET /api/events (SSE)             │ POST /api/*
            ▼                                   │
 ┌──────────────── browser UI (React, prebuilt) ───────────────┐
 │  Activity · Plan · Board · Review · Verify · Ship           │
 └─────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install
npm run build          # writes dist/, which the plugin loads directly
```

Then load the plugin. For a session at a time:

```bash
claude --plugin-dir /path/to/cc-ui-harness
```

Or permanently, via a local marketplace:

```bash
claude plugin marketplace add /path/to/cc-ui-harness
claude plugin install cc-harness@cc-harness-local --scope user
```

Verify the wiring against your installed CLI:

```bash
./bin/harness doctor
```

## Use

In any session with the plugin enabled:

- `/harness <task>` — run the task through the full loop
- `/harness-review` — publish the current changes for line-level review
- `/harness-ship` — verification and PR
- `/harness-open` — open the UI
- `/harness-doctor` — check the wiring

`./bin/harness url` prints the address; `./bin/harness open` opens it in a
browser; `./bin/harness status` lists every live session. The UI does not open
itself unless you set `autoOpen` — the plugin is installed globally, and a tool
should not open windows you did not ask for.

## The task board

Approving a plan turns it into a kanban board — TODO, IN PROGRESS, BLOCKED,
DONE — that answers the question the activity feed cannot: *where in the work
is the agent right now, and what has each piece actually touched.*

Claude claims a card before it edits, records what it changed as it goes, and
closes the card with a note. Two things make the board trustworthy rather than
a second thing to keep in sync:

- **Files are observed, not reported.** The daemon fingerprints the working
  tree at each transition and attributes whatever changed to the card that was
  in progress — so it is right whether the edit came from an `Edit` call, a
  heredoc, or a formatter.
- **Blocking is first class.** When Claude hits something it does not know, it
  moves the card to BLOCKED with the question on it instead of guessing. Your
  answer is written back onto the card as a decision, so the reasoning behind a
  change outlives the session.

You can drag cards yourself; Claude is told when you do.

The Review tab reconciles the board against the diff — a card marked done that
touched nothing gets flagged, and so does a changed file no card claims.

## How feedback reaches the session

Two paths, both landing in the session transcript:

**Gates (park and wait).** When Claude publishes a plan, a diff, or a check
run, a gate opens. Claude calls `harness_await`, which holds. If Claude ends
its turn instead, the `Stop` hook holds the turn open. When you submit in the
UI, the session resumes with your verdict — including your edited plan or your
line comments — as its next input.

**Async messages.** Anything you send while Claude is working queues and is
delivered at the next turn boundary, so you never have to interrupt. A message
is never a verdict: answering a gate is always a separate, deliberate action.

**Questions.** When Claude needs an answer it calls `harness_ask` (or blocks a
card) rather than writing a question into the terminal, so the question appears
in the UI as a gate you can answer — with one-click options where it offered
them, or as a form with described choices and multi-select when it asked
several things at once. The question card sits above the tab strip, so it is
answerable while you read the plan, the diff or the board underneath it.

**Waiting sessions come to you.** Anything Claude has stopped on is lifted into
the rail's *Pinned / Action required* group, whether or not you pinned it, and a
chime plays when a session starts waiting — mute it with the bell in the sidebar
header. Rename a session from the rail (the pencil, or double-click it) when its
auto-generated name does not say what it is about.

**Threads.** Line comments are a conversation: Claude replies in the thread
saying what it changed or why it disagrees, and you can reply back or reopen a
thread it resolved too eagerly.

**Rounds.** Each published diff is a numbered round. On round two and later the
review offers a *changed since round N* filter and marks the files that moved,
so a re-review costs you only what actually changed.

Both waits are bounded and every failure path is fail-open: if the daemon is
down, hooks print nothing and exit 0, and the session is unaffected.

## What costs tokens, and what doesn't

Derived by the daemon for free, from hooks and the transcript on disk:

| In the UI | Source |
| --- | --- |
| Task checklist | `PostToolUse(TodoWrite)` |
| Files touched | `PostToolUse(Write\|Edit\|MultiEdit\|NotebookEdit)` |
| Command log | `PostToolUse(Bash)`, `PostToolUseFailure` |
| Narration, reasoning, tool calls | the session transcript JSONL |
| The entire diff | `git diff`, run server-side |
| Turn boundaries, idle state | `Stop`, `Notification` |
| Files behind each task card | working-tree fingerprints at each transition |
| Token spend per stage | `usage` on assistant messages in the transcript |

Claude pays only for small structured tool calls, and the UI itself is a static
bundle served from disk — it is never generated by the model.

## Configuration

`~/.claude/cc-harness/config.json`, overridden per repo by
`.claude/harness.json`. See [config/defaults.json](config/defaults.json) for
the full shape and [docs/CONFIG.md](docs/CONFIG.md) for what each key does.

Custom per-stage instructions go in
`~/.claude/cc-harness/instructions/<stage>.md` and are handed to Claude only
when that stage is entered.

Ship providers are pluggable. `kind: "command"` runs in the daemon (`gh` by
default). `kind: "mcp"` hands Claude a directive plus the composed title and
body, so a PR can be opened through any connected MCP server — Bitbucket,
GitLab, Linear — without the daemon knowing anything about it.

## Development

```bash
npm run typecheck
npm run build          # or: npm run build:watch
npm test
npm run check          # all three
```

- `src/daemon` — the singleton server: state, gates, board, git, checks, ship
- `src/mcp` — the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui` — the browser client (React, `@dnd-kit` for reordering)
- `src/shared` — types, config, the diff parser, the hook contract
- `bin/hook-relay.sh` — sh + curl, so no Node process starts per tool call

The daemon, the MCP server and the CLI have no runtime dependencies. The
browser bundle carries React, compiled once; everything in `devDependencies` is
build- or test-time only, and `dist/` is committed so the plugin works without
an install step.
