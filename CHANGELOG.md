# Changelog

## Unreleased

### The README

- **Screenshots** of each step, from demo plans that
  `scripts/demo/screenshots.mjs` seeds into a throwaway daemon, so they can be
  taken again when the page changes.
- **What it installs:** every skill (when the agent uses it, and what it may
  lead the agent to do), the MCP server and its ten tools, every hook with
  what it sends and what is kept, the slash commands, the CLI, and what
  Coplan reads, writes and connects to.
- **Resource footprint:** measured memory, CPU, latency, disk and context
  size for the daemon, the MCP server, the hooks and the page, and what
  drives the cost of a build.
- **Recommended usage:** when Coplan is worth it, and how to set up checks,
  size a plan, and choose the review mode, parallelism and round limit.
- The step-by-step walkthrough moved to [docs/GUIDE.md](docs/GUIDE.md).

## 0.3.0

### The plan the agent reads is the plan you see

- The agent can no longer write over a change you made that it has not read
  yet: the edit is refused with what to read first. Tasks carry a revision,
  so two writers cannot silently overwrite each other.
- The agent is sent every change you made, and the build prompt it receives
  is exactly the one you read in the dialog: a prompt that changed after you
  read it is refused, not sent. Text you write cannot break the prompt's
  structure.
- Skills and docs use the real `harness_plan_edit` API; a test checks every
  example against the tool schemas.
- A daemon's lock is trusted only once that daemon answers, and is claimed
  atomically, so two daemons cannot both think they own it.

### The agent as auditor

- The agent can comment on the plan, a box or an arrow without changing it,
  read the plan without marking it read (`peek`), and add, change or remove
  one box or arrow without restating the whole diagram.
- `harness_plan_check` lists what the plan leaves open: tasks with no
  detail, boxes no task builds, branches a stack of pull requests cannot
  follow.
- A subagent's brief carries the plan's sections and the comments on the
  boxes it builds.

### Stacked pull requests and the build lifecycle

- Branches are planned so a stack of pull requests can follow them, and
  tracked as they are pushed and opened (`harness_branch_update`); a build
  ends with its report.
- Every path to *done* goes through the task's gates: a review round with a
  verdict, passing checks, and every required review hook reported.
- Scope can change mid-build without re-scoping what you signed off.

### Hardening

- The access token is never a cookie and never on a command line: the page
  keeps it for its own origin and sends it as a header, the live stream uses
  single-use tickets, and Coplan's files are readable by you alone.
- A plan that cannot be saved says so instead of failing silently. A save is
  written whole and synced before it replaces the old one.
- *Answer in …* opens Claude, Codex and Cursor session links, checked first.
- The canvas keeps undo consistent with what is saved, waits for a save in
  flight before Confirm or Submit, leaves Tab and Enter to the toolbar, and
  F6 moves between the canvas and its details.
- Hook `paths` take `{a,b}` and `!glob`; config files take comments and
  trailing commas; unknown keys and bad values are reported, saying what is
  used instead. `config/defaults.json` is gone.
- An installed but unbuilt plugin says so at the start of a session.
  `coplan doctor` checks node, curl, both configs, the daemon's version and
  pid, and a hook sent through the real relay, and cleans up after itself.

### Proposals: the agent suggests, you decide

- `harness_plan_propose` lets the agent suggest a change instead of making
  it: a batch of edits with its reason. It waits beside the plan with
  *Accept* and *Reject*, and *Show on canvas* draws the diagram as it would
  be, marking what it adds, changes and removes. Accepting applies the
  edits as yours; rejecting keeps the plan and tells the agent why. The
  agent hears the answer the next time it reads.
- A proposal is checked when it is made, and goes out of date if what it
  changes moves first. Once the design is confirmed or the plan submitted,
  it is how the agent suggests what it may no longer change itself.

### Make the build yours

- `pullRequests` in `.coplan/config.json` chooses how a build's pull
  requests are opened — `gh`, Graphite, or by you — and when: as each
  branch is done, once you say, or never; with a `template` each
  description is written from. `harness_task_next` says when each is due.
- `instructions` add your own words to the design prompt, the build prompt,
  every task's brief, and what its reviewer checks.
- `review.model` picks the reviewer subagent's model; `final.blocking`
  holds the build report until the final checks pass.
- `planCheck` sets how each plan-check rule counts: an `error` holds
  *Confirm design* and *Submit*, a rule turned `off` is not shown.
- A hook can run in a folder (`cwd`) with its own variables (`env`), for a
  monorepo.
- `~/.claude/cc-harness/coplan.json` and `instructions/*.md` there are your
  defaults for every repository, under each repository's own config.

### The same Coplan in every agent

- The commands find the plugin where an agent leaves its path empty; the
  docs list the commands each agent really ships; Codex's question hook
  covers `request_user_input_async`.
- Platform support is stated: Linux and macOS, and Windows through WSL.
- CI runs on macOS too, on the oldest supported Node (20.11.0), lints the
  shell scripts, and validates the Claude Code plugin; each release is tagged.

### The session list holds only your plans

- **Only sessions that used Coplan are listed.** Every session with the
  plugin registers, so the list used to fill with chats that never asked for
  a plan. A session now joins it once you type `/coplan` (`$coplan` in
  Codex), the agent loads the skill itself, or it calls a Coplan tool;
  sessions that already have a plan stay. The session on screen is always
  listed, so a `/coplan-open` link never strands you.
- **Row actions no longer sit on the title.** Rename, pin and delete keep a
  space of their own at the end of a row's first line, on touch screens too,
  and step aside while you rename. A long branch or folder name is cut short
  on its line instead of breaking across several, and the folder name is
  left out when the group header already says it.

### Build after installing, with pnpm

- The project uses **pnpm**: `pnpm-lock.yaml` replaces `package-lock.json`,
  and `packageManager` pins the version for corepack. `pnpm install` installs
  and builds; `pnpm check` runs everything CI does.
- `dist/` is no longer committed. After installing or updating the plugin,
  build it once: `/coplan-setup` in Claude Code or Cursor, or ask Codex to set
  up Coplan (each runs `pnpm install` in the plugin's directory, which builds
  it), then restart the agent. Until then the plugin's tools and hooks stay
  off, and `coplan` says how to build it. CI no longer compares a committed
  `dist/` with the source.

### Design first, then a linked task list, then a reviewed build

- **Confirm the design before the task list.** The Architecture view's main
  action is now *Confirm design*: it shows exactly what the agent will be
  asked, and confirming locks the diagrams, sections and summary. Your next
  message carries the design to the agent (in Cursor you paste it, or its next
  `harness_plan_read` picks it up), which breaks the planned tasks into the
  task list with the new `harness_tasks_publish`. The title, the tasks, which boxes
  they link to and comments still change; *Reopen design* unlocks the rest.
  Submitting now needs a confirmed design, and *Reopen for changes* after
  submitting unlocks the tasks while the design stays confirmed.
- **Tasks say what blocks them, and where they land.** Each task can depend
  on others (`dependsOn`; a parent's apply to its subtasks, and depending on
  a parent waits for all of it), name a branch (inherited by subtasks), set
  its own review mode, and link the boxes it builds (`builds`). Loops and
  dependencies on a task's own parent or subtask are refused with the reason.
  The Tasks view marks each task *ready* or what it *waits on*, edits all of
  this in a task's details, and shows the **build order** — steps of tasks
  that can be built side by side — and how the **branches stack** into pull
  requests. The read-back and the prompts carry the same.
- **What can start, and one task's brief.** `harness_task_next` lists the
  ready tasks, how many to run at once, what is in progress and at which
  step, and what the rest wait on — and, once everything is done, how to
  finish. `harness_task_brief` gives one task self-contained, to hand to a
  subagent: the objective, the boxes it builds with their decisions and
  connections, what it comes after and before, its scope, its branch, and
  its checks.
- **Implement → review → refine, under your control.** The submit dialog
  sets how each task is built: who reviews it (a fresh subagent, the agent
  itself, you, or the checks alone), how many tasks run at once, and how
  many review rounds before the agent stops and asks you. `harness_task_update`
  reports a task's step and the checks it ran; starting a task that still
  waits on another is refused, and so is marking one done while its last
  checks failed. Board cards show the step, the round and the checks.
- **Checks in `.coplan/config.json`.** A repository lists what every task
  runs, per stage (`implement`, `review`, `final`), with the build's defaults
  and its base branch. The checks reach the agent in the prompts and briefs;
  `coplan check <stage>` runs a stage and shows only what failed, and
  `coplan init` / `/coplan-init` writes a starting point. Coplan never runs
  them itself.
- **Skills for the build.** `coplan-build` runs a submitted plan: ready
  tasks only, independent ones in parallel by subagents (in worktrees when
  on different branches), stacked branches and pull requests, and the final
  report. `iric` is one task's implement → review → refine cycle, with a
  reviewer prompt and the round limit. `coplan` now covers the design and
  the task list.
- **The build report.** Once every task is done the agent writes a report with
  `harness_plan_edit {op: "report"}`; it leads the Overview.

### Codex and Cursor

- Coplan now works in **Codex** and **Cursor** as well as Claude Code. The
  same repository is a plugin for all three: `.codex-plugin/plugin.json` and
  `.cursor-plugin/plugin.json` sit beside `.claude-plugin/`, each pointing at
  that agent's own hooks (`hooks/codex.json`, `hooks/cursor.json`) and MCP
  config (`mcp/codex.json`, `mcp/cursor.json`). Install with
  `codex plugin marketplace add bert-bae/coplan` and
  `codex plugin add coplan@coplan`, or from Cursor's plugin search with the
  repository's URL.
- Codex keeps a plugin's hooks off until you trust them: open `/hooks` in
  Codex once after installing (and after each update).
- Every session records which agent it runs in. The page names it — "Codex
  is working", *Answer in Cursor* — and the session rail labels each row
  once more than one agent is in the list. `coplan status` shows it too.
- Each agent is told to ask with its own question tool: `AskUserQuestion` in
  Claude Code, `request_user_input` (Plan mode) in Codex, `AskQuestion` in
  Cursor. A Codex `request_user_input` or permission request shows the
  waiting banner; *Answer in Codex* opens the thread in the Codex app
  (`codex://threads/…`).
- Codex's MCP server finds its thread from each tool call. Cursor's, which
  one window shares across its chats, finds the chat in its workspace that
  was active last, asking Cursor for the workspace (MCP roots) when its
  config cannot say.
- Cursor's hooks cannot reliably add to a prompt, so in Cursor submitting a
  plan copies the build prompt for you to paste; pasting it counts as
  delivering it, and so does the agent's first `harness_plan_read` after you
  submit ("build the plan" will do).
- `coplan open` and `coplan url` find the session they were run from in any
  agent, falling back to the one most recently active in the current folder.
- `coplan doctor` checks the Codex and Cursor files and replays a hook in
  each agent's format.

### Renamed to Coplan

- The project is now **Coplan**, open source under the MIT license. The
  repository moved to `bert-bae/coplan`; GitHub redirects the old address.
- The plugin and its marketplace are both named `coplan`, so it installs
  straight from GitHub with `claude plugin marketplace add bert-bae/coplan`
  and `claude plugin install coplan@coplan`. If you installed
  `cc-harness@cc-harness-local`, uninstall it, remove that marketplace, and
  install `coplan@coplan`.
- The slash commands are `/coplan`, `/coplan-open`, `/coplan-doctor` and
  `/coplan-restart` (they were `/harness…`), and the CLI is `bin/coplan`
  (it was `bin/harness`). The hook relay is `bin/coplan-hook-relay.sh`, so
  nothing generic lands on your `PATH`. The UI, the CLI and what Claude is
  told all say Coplan.
- The MCP tools and the data directory keep their old names
  (`harness_plan_*`, `~/.claude/cc-harness`, `CC_HARNESS_HOME`,
  `.claude/harness.json`), so existing plans and configuration carry over
  unchanged.

### Submitting the plan

- **Review & submit plan**, on the Architecture view, shows the exact prompt
  Claude will be given — built by the daemon from the plan as it stands, with
  anything you add for Claude and what you changed that it has not read yet
  — and submitting locks the plan. The preview is rebuilt as you type, and a
  submission made against a plan that moved on since is refused.
- **Who builds it**: this Claude session, which gets the prompt with your
  next message in its chat (once; pasting it yourself is not sent twice), or
  somewhere else, with a prompt written for an agent without the harness
  tools, copied for you to paste.
- **Locked.** A submitted plan is the final design: the canvas is read-only
  (boxes still fill up with progress, and a box's panel links each task to
  its card), the Tasks tab is a read-only board, and the Overview's controls
  are off. Claude can still report tasks, add work it discovers and answer
  comments; redesigning and republishing are refused until every task is
  done. *Withdraw* or *Reopen for changes* unlocks it.
- **Following the build.** A strip under the header says whether Claude has
  the prompt, which task it is on, what is blocked, and when it is built. On
  the board, a card that changes column glows as it arrives, and the move is
  announced to screen readers. The session rail shows *submitted*,
  *building* or *built*.
- A plan too long for one message is sent as the instructions, summary and
  task list, with a pointer to `harness_plan_read`; the review says so.

The architecture canvas is easier to fill in and opens organised, and what
Claude reads back about it is the design you ended up with — not a replay of
every drag and keystroke.

### Editing the canvas faster

- **Right-click menus** for empty canvas (add a box of any kind right there,
  paste here, tidy, fit), a box (rename, kind, add after/before/beside,
  connect to, copy, duplicate, delete keeping the flow), an arrow (label,
  reverse, dashed, arrowheads, insert a box, delete) and a selection. ⇧F10
  or the menu key opens the same menu from the keyboard.
- **Reconnect by dragging an arrow's end.** A selected or hovered arrow shows
  a grip at each end; drag one onto another box. The arrow keeps its label
  and style.
- **Relationship highlighting.** Hover or select a box: what it sends to,
  what sends to it and two-way links each get their own colour and a badge
  in words, their arrows flow in their direction, and everything else fades.
  Hold Alt for two steps out. An arrow lights up its two ends.
- **Undo and redo** (⌘/Ctrl+Z, ⇧⌘/Ctrl+Z, toolbar ↶ ↷) for every canvas
  edit. A change made elsewhere ends the history rather than being undone.
- **Building by keyboard**: Tab adds the next box along the flow, ⇧Tab one
  before, Enter one beside (same kind, same parents); typing on a selected
  box renames it.
- **Drop a box onto an arrow** to put it in between; **Alt+⌫** deletes a box
  and joins the flow around it.
- **⇧1** fits the diagram, **⇧2** zooms to the selection, **?** lists every
  shortcut.

### What Claude reads

- **Diagrams read as an architecture.** `harness_plan_read` (and *Copy as
  Markdown* on the diagram panel) renders each diagram as the system's shape —
  entry points, data stores, queues, external systems — then every part in
  the order the flow reaches it, with its role, description, decisions and
  the tasks that build it, then every connection in words. No coordinates,
  no layout direction.
- **"Since you last read" is the net change.** It compares the plan Claude
  last read with the plan now: a box added and deleted again leaves nothing,
  a box renamed three times is reported once by its final name. Changes are
  grouped — parts added, removed, changed; connections connected,
  disconnected, reversed, restyled — and `changes_only` quotes edited prose
  in its final form.
- **Layout is not news.** Dragging boxes or flipping the direction is saved
  but never counts as a change for Claude, in the read, the prompt notice or
  the header.

### On the canvas

- **Descriptions.** Every box has a description (what it does, what it owns,
  how others talk to it) beside its decisions. Claude is asked to fill both
  in while planning. Hover a box's ⓘ for a summary: description, decisions,
  the tasks that build it and its connections.
- **Organised from the start.** Layout leaves room between ranks for arrow
  labels, routes arrows around the boxes they pass, puts unconnected boxes on
  a shelf instead of beside the flow's start, never zooms a small diagram
  past its real size, and picks top-to-bottom for long, narrow flows when
  Claude does not say. A box Claude adds to an arranged diagram lands beside
  what it connects to.
- **Editing.** Double-click empty canvas to add a box; drag from any edge of
  a box onto another to connect, or into space for a new connected box;
  double-click a box or an arrow's label (or F2) to rename it in place.
  Arrows join whichever sides face each other, so moving a box never leaves
  them looping round it.
- **Copy and paste.** ⌘/Ctrl+C, X, V and D copy, cut, paste and duplicate
  boxes with everything on them and the arrows between them, across diagrams
  and tabs. ⌘/Ctrl+A selects everything.
- **Connections** can be reversed, re-pointed, made dashed, and drawn one
  way, both ways or without direction, from their panel; a box's panel lists
  its connections with a way to add and remove them.
- **The panel's fields fit what goes in them:** inputs for a name, a
  subtitle and an arrow's label; a growing textarea for a description; a
  markdown editor for decisions; a visual kind picker. Several selected
  boxes can have their kind changed at once.

## 0.2.0

The harness is now a planning workspace: architecture and task breakdown in,
progress out. Every exchange with Claude happens in Claude's own chat.

### Changed

- **Planning only.** The review loop is gone — gates that held turns open,
  diff review, checks, ship, the message box. The harness never talks to
  Claude and never holds a turn.
- **Architecture first.** Diagrams are React Flow canvases (about 70% of the
  view) with a details panel: label, kind, one-line detail, markdown notes and
  decisions, the tasks that build each box, and its connections. Boxes show
  their tasks' progress. dagre lays out what Claude publishes.
- **Tasks** as an outline you reshape (drag to nest, Alt+arrows) and a status
  board you follow; rows link to the boxes they build.
- **Questions are answered in Claude.** `AskUserQuestion`, permission and
  idle prompts, and turns that end on a question show as a banner with
  *Answer in Claude*, linking to the session in the desktop app
  (`claude://claude.ai/code/session_…`) or on the web. Cloud sessions and
  local sessions with Remote Control get a link; others get a hint.
- **Four MCP tools**: `harness_plan_publish`, `harness_plan_read`,
  `harness_plan_edit`, `harness_task_update`.
- The session list folds to a rail of initials (☰ or `[`).

### Hardening

- Saves carry the revision they were made against; a save over a newer
  change (Claude's or another tab's) is refused rather than silently
  overwriting it. Editors keep your text when that happens. Canvas saves are
  serialized and coalesced.
- An unreadable state file is moved aside (`state.corrupt-*.json`) instead of
  being overwritten; plans from any earlier build are normalized on load.
- The UI is served with a strict Content-Security-Policy, `no-referrer`
  (the first URL carries the auth token), `nosniff` and frame denial.
- Cross-origin writes are refused even with valid credentials; malformed JSON
  and paths are 400s; request bodies are capped at 2 MB; server timeouts are
  bounded.
- Live updates stream only the session a page is showing, and the session
  list broadcast is coalesced per tick.
- Plans are bounded: tasks, sections, diagrams, boxes, arrows, comment
  threads and replies.
- A view that fails to render shows an error card instead of a blank page;
  loading and unavailable-session states replace the "no session" flash.
- CI: typecheck, build, a check that committed `dist/` matches the source,
  tests, the `harness doctor` self-test, and `npm audit` on Node 20 and 22.

### Migration

Sessions saved by 0.1 load automatically: plan steps become tasks, and
review-loop state is dropped. Old config keys (`gateHoldSeconds`, `ship`, …)
are ignored. New key: `openClaudeOnQuestion`.
