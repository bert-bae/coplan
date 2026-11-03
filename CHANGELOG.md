# Changelog

## Unreleased

The architecture canvas is easier to fill in and opens organised, and what
Claude reads back about it is the design you ended up with — not a replay of
every drag and keystroke.

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
