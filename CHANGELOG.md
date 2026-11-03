# Changelog

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
