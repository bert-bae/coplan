---
name: coplan
description: Plan a task visually in the Coplan UI — architecture diagrams the user can reshape, and a task breakdown with subtasks that tracks your progress as you build. Use when the user types /coplan or $coplan, asks to "plan this in Coplan", or wants to see and shape the plan before work starts.
---

# Planning in Coplan

Coplan is a planning workspace in the user's browser. You publish a plan
there; the user reshapes the architecture on a diagram canvas, reorganizes the
task tree and comments on anything. As you build, the same page shows your
progress through the tasks.

**All conversation stays here, in chat.** Coplan never talks to you and
has no way to answer you. When you need a decision, ask it here with your
question tool — `AskUserQuestion` in Claude Code, `request_user_input` in
Codex, the ask-question tool in Cursor — or plainly in chat if you have none.
Coplan shows the question and links the user back to this session to answer
it. When the user has worked over the plan, they tell you so here, and you
read it back.

Coplan's tools are the MCP server `harness`: `harness_plan_publish`,
`harness_plan_read`, `harness_plan_edit` and `harness_task_update`. Your
agent may show them with a prefix (`mcp__harness__…`); they are the same
tools.

## 1. Investigate, then publish the plan

Read the code first. Then call `harness_plan_publish` with:

- **title** and **summary** — what is being built, and the approach in one
  paragraph.
- **tasks** — the breakdown, nested with `subtasks`, in execution order. A
  leaf task is one concrete piece of work; put the approach and acceptance
  criteria in `detail` and the files you expect to touch in `files`. Give a
  task an `id` (e.g. `"cache-client"`) when a diagram box should link to it.
- **diagrams** — the architecture, which is where most design decisions are
  made. Each diagram is `nodes` and `edges`:
  - a node has `id`, `label`, `kind` (`component`, `service`, `datastore`,
    `queue`, `external`, `actor`, `note`), `detail` (a few words on the box:
    technology or role), `description`, `notes` and `taskIds` (the tasks
    that build it — the box then shows their progress);
  - an edge has `source`, `target`, optional `label` (what flows along it),
    `dashed` (optional, async or future) and `arrows` (`both` or `none`
    when it is not one-way).

  **Fill in every box as you plan it.** `description` is two to four
  sentences on what the part does, what it owns and how others talk to it —
  the user reads it by hovering the box, and it is how the diagram is read
  back to you. `notes` holds what you decided about the part and why, and
  what you ruled out. A box with only a label leaves the user nothing to
  react to.

  Do not give coordinates or a direction unless you mean it — the UI lays
  diagrams out to fit and the user arranges them. One diagram per idea
  (components, a request's path, data flow).
- **sections** — supporting prose: Context, Risks, Out of scope. Markdown.

Then ask, with your question tool, whatever you need decided before
building — several questions at once, with options. Tell the user the plan is
ready, with the UI link the publish returned.

## 2. Read it back when they say so

When the user says they have reviewed or changed the plan — or a prompt
arrives with a `[cc-harness]` note that it changed — call `harness_plan_read`.
It leads with what is different from what you last read — the net effect of
their edits, not every step, and never where boxes were dragged: parts and
connections added, removed or changed, tasks moved or added, comments. The
diagrams follow as an architecture description: parts in flow order with
their descriptions, decisions and tasks, then every connection. Then:

- **Their edits** — their structure wins. Work from their task tree and their
  diagram, not yours.
- **Comments** — act on each, then reply in its thread with
  `harness_plan_edit` `{op: "reply", threadId, text}`; resolve it if settled.

Use `harness_plan_edit` for targeted changes (a batch of ops, applied
together). Use `harness_plan_publish` again only for a wholesale rewrite, and
keep the ids of items that survive. Publishing is refused while the user has
changes you have not read — read first.

## 3. Build when the user submits the plan

The user signs the plan off from Coplan: they read the exact prompt you
will get, and submit. The plan is then **locked** — the diagrams, sections and
task tree are final — and Coplan only follows your progress on its task
board. A `[cc-harness] Build the plan …` prompt with the whole plan (or, for a
long one, the task list and a pointer to `harness_plan_read`) reaches you with
their next message in chat — or, in Cursor, they paste it. If they tell you
the plan is submitted, or to build it, and no such prompt has reached you,
call `harness_plan_read`: the first read after submitting returns the build
prompt. Build from it, in order.

While the plan is locked, only tracking applies: `harness_task_update`,
`upsert_task` to add work you discover, and `reply`/`resolve` on comments.
Anything that would redesign it is refused, and so is publishing over it
until every task is done. If the design has to change, stop and ask in chat —
the user can reopen the plan in Coplan.

If the user tells you to start without submitting, build all the same; the
plan just stays open for them to edit.

## 4. Track progress while you build

Work through the task tree in order and keep statuses truthful with
`harness_task_update` — the board moves as you report:

- `in_progress` when you start a task,
- `done` with a one-line `note` of what you did,
- `blocked` with a `note` saying what on — and ask the question with your
  question tool.

If you discover work that is not on the plan, add it as a task
(`upsert_task` with `parentId`) before doing it, and link it from the box it
builds, so the plan stays the map of the work.

## Opening Coplan

The publish result carries the plan's address. To open it in a browser, or
to check the wiring, use the `coplan` CLI: it is `bin/coplan` in the plugin's
folder, two levels up from this file (`../../bin/coplan`).

- `coplan open` opens this session's plan (and prints the address),
- `coplan doctor` checks the plugin wiring end to end,
- `coplan restart` restarts the daemon after Coplan is updated.

In Claude Code and Cursor these are also `/coplan-open`, `/coplan-doctor` and
`/coplan-restart`.

## Rules

- Ask in chat with your question tool, never in the plan. Coplan links the
  user to you; it cannot carry an answer.
- Read before you republish, and never overwrite the user's structure.
- A submitted plan is the user's sign-off: build it, do not redesign it.
- Keep ids stable; quote them exactly in edits (`t4`, `d1`, `c3`, node ids).
- If the Coplan tools return a daemon error, tell the user once and carry on
  in chat. The UI is an aid, not a dependency.
