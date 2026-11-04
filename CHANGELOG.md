# Changelog

## Unreleased

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
