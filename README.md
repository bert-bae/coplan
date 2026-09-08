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
            │ (Stop holds the turn at a   │ (publishes gates, notes,
            │  gate, briefly)             │  replies; never waits)
            ▼                             ▼
 ┌──────────────── cc-harnessd (one per user) ─────────────────┐
 │  sessions · stage machine · transcript tailer               │
 │  git diff · gates · checks · ship · static UI · SSE         │
 └──────────┬───────────────────────────────────┬──────────────┘
            │ GET /api/events (SSE)             │ POST /api/*
            ▼                                   │
 ┌──────────────── browser UI (React, prebuilt) ───────────────┐
 │  Conversation · Plan · Board · Review · Verify · Ship       │
 └─────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install
npm run build          # writes dist/, which the plugin loads directly
```

The build compiles `src/ui/style.css` with Tailwind — the utility engine and
the `@theme` token vocabulary — and bundles the rest with esbuild. `dist/` is
committed, so installing the plugin still needs no build step of its own.

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
- `/harness-restart` — restart the daemon after a rebuild

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

## Worktrees

A session can be isolated in a git worktree — `EnterWorktree`, or `claude` run
with worktree isolation — and then it works in `<repo>/.claude/worktrees/<name>`
while every hook payload keeps reporting the directory it was *launched* in.

The harness reads the relocation out of the transcript, which is the only place
the CLI records it, and re-anchors the session on the worktree: the diff, the
observed-file attribution, the checks and the commit-and-push in the ship stage
all run against the tree the session is actually editing. Relocation is watched
continuously, so entering or leaving a worktree mid-session moves the harness
with it, and a daemon that starts up mid-session catches up by scanning the
transcript once.

Sessions keep the name of the repository they belong to and are told apart by
their worktree, so several sessions on the same repo are distinguishable in the
switcher, in the header, and in `harness status`.

## Housekeeping

The rail's footer holds the two actions that belong to the harness itself
rather than to any one session.

**Restart.** The daemon runs whatever was in `dist/` when it started, so a
rebuilt plugin does nothing until it is replaced. Restarting hands the
successor the port *and* the token, so the tab that asked for the restart
reconnects to it by itself instead of being stranded on a dead address —
`harness restart` and `/harness-restart` do the same thing from a terminal or
a session. Checks and ship commands still running are killed; the UI says how
many.

**Clean up.** The harness leaves files in two places, and neither empties
itself: session directories under `~/.claude/cc-harness` outlive their session
by design, so a `--resume` can still find its history, and a ship writes its
commit message and PR body to the temp directory in a `finally` that a SIGKILL
never reaches. The panel reports what could go, grouped by what losing it would
cost, and removes only what you tick:

| Group | What it is |
| --- | --- |
| Finished sessions | Recorded history the daemon no longer lists, untouched for over a day |
| Interrupted writes | `.state.*.tmp` files from a daemon killed mid-save |
| Scratch files | Commit messages and PR bodies from a finished ship |
| Daemon log | The older part of `daemon.log`, trimmed rather than deleted |
| Stale lock file | An address left behind by a process that is gone |

Nothing the daemon is currently holding is ever offered up, and the candidate
list is re-derived at the moment you press the button rather than trusted from
the report on screen — a session that came back to life in between is excluded
by id, not by luck. Only recorded history is unticked by default; everything
else is unambiguously garbage. `harness clean` does the same from a terminal,
with `--dry-run` to only list, and an optional group name to narrow it.

## How feedback reaches the session

Two paths, both landing in the session transcript:

**Gates (stop and wait).** When Claude publishes a plan, a diff, or a check
run, a gate opens and the turn is held open for a few minutes — long enough
that answering in the browser resumes the session there and then, which is the
whole point of having the UI. There is no way to wake a stopped Claude Code
session from outside, so that window is the only moment at which a click can
move it on.

Miss the window and the turn ends for good: the terminal comes back, and the
gate stands open in the UI for as long as you need. Your verdict is then handed
to the session at the top of your next message to it. Either way nothing polls
and no tokens are spent while you read.

The window is bounded and single-round — it never re-blocks on expiry, which is
what once left a session structurally unable to stop for half an hour. Set
`gateHoldSeconds` to `0` to get the terminal back the instant a gate opens.

**Async messages.** Anything you send while Claude is working queues and is
delivered at the next turn boundary, so you never have to interrupt. A message
is never a verdict: answering a gate is always a separate, deliberate action,
and a message sent while a gate is open leaves that gate standing.

**Skipping a gate.** Sometimes the reason for typing was *stop, do this
instead*, and having Claude answer and then go back to the gate is not what you
meant. **Send now** closes the gate without a verdict, and Claude is told the
gate is gone rather than left expecting a verdict that is not coming. It is a separate button from the
default send, and the gate is recorded as *skipped* rather than quietly
disappearing.

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

**Every move a gate offers is named.** A gate's exits come from one table, read
both by the banner — which lists them from whatever tab you are on — and by the
stage's own panel, which renders them as the buttons themselves with what each
one does to the session underneath. The banner cannot promise a move the tab
does not offer, and the list says outright that a message is not on it.

**Stages say what became of them.** Each tab carries the verdict it was given —
*approved*, *changes requested*, *rejected*, *skipped* — with when it landed,
and whether Claude is currently acting on it. A stage nobody has looked at and
a stage that was signed off ten minutes ago no longer look identical. The
Conversation tab lists all five at once, and a working session animates: in the
tab strip, in the header, at the tail of the feed, and in the rail, so a live
session is never mistaken for a stale page.

**Talking happens in one place.** The Conversation tab is the only one with a
message box. Every other tab advances through its own gate, with its own
buttons; a message box there could do nothing but queue text behind that gate
while looking like the way to answer it. From the Conversation you can still
talk to a session parked anywhere in the pipeline — *Send now* drops the gate
and hands Claude the message straight away.

**One theme attribute, two themes.** Light and dark are both explicit token
sets hanging off `data-theme` on the root, and `system` is resolved to one of
them at runtime. Choosing Dark on a machine whose OS is set to light now
actually turns the app dark — previously the dark tokens lived only inside a
`prefers-color-scheme` media query, so the choice changed an attribute that no
rule matched.

**Keyboard and screen reader.** The tab strip is one tab stop with arrow-key
navigation and a real `tabpanel` relationship; a diff line is readable text
with a named button in the gutter to comment on it, rather than a button whose
label replaced the code. Under 900px the session rail becomes a drawer, the
file rail floats, and a stage's response panel docks to the bottom so the
approve button is never a page away.

**Rounds.** Each published diff is a numbered round. On round two and later the
review offers a *changed since round N* filter and marks the files that moved,
so a re-review costs you only what actually changed.

Every wait is bounded and every failure path is fail-open: if the daemon is
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

- `src/daemon` — the singleton server: state, gates, board, git, checks, ship,
  housekeeping
- `src/mcp` — the stdio MCP server (hand-rolled JSON-RPC, no dependencies)
- `src/ui` — the browser client (React, `@dnd-kit` for reordering)
- `src/shared` — types, config, the diff parser, the hook contract
- `bin/hook-relay.sh` — sh + curl, so no Node process starts per tool call

The daemon, the MCP server and the CLI have no runtime dependencies. The
browser bundle carries React, compiled once; everything in `devDependencies` is
build- or test-time only, and `dist/` is committed so the plugin works without
an install step.
