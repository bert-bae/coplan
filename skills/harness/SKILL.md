---
name: harness
description: Plan a task visually in the harness UI — architecture diagrams the user can reshape, and a task breakdown with subtasks that tracks your progress as you build. Use when the user types /harness, asks to "plan this in the harness", or wants to see and shape the plan before work starts.
---

# Planning in the harness

The harness is a planning workspace in the user's browser. You publish a plan
there; the user reshapes the architecture on a diagram canvas, reorganizes the
task tree and comments on anything. As you build, the same page shows your
progress through the tasks.

**All conversation stays here, in chat.** The harness never talks to you and
has no way to answer you. When you need a decision, ask it here with
`AskUserQuestion` — the harness shows the question and links the user
straight back to this session to answer it. When the user has worked over the
plan, they tell you so here, and you read it back.

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

Then ask, with `AskUserQuestion`, whatever you need decided before building —
several questions at once, with options. Tell the user the plan is ready.

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

## 3. Track progress while you build

Once the user says to start, work through the task tree in order and keep
statuses truthful with `harness_task_update`:

- `in_progress` when you start a task,
- `done` with a one-line `note` of what you did,
- `blocked` with a `note` saying what on — and ask the question with
  `AskUserQuestion`.

If you discover work that is not on the plan, add it as a task
(`upsert_task` with `parentId`) before doing it, and link it from the box it
builds, so the plan stays the map of the work.

## Rules

- Ask in chat with `AskUserQuestion`, never in the plan. The harness links the
  user to you; it cannot carry an answer.
- Read before you republish, and never overwrite the user's structure.
- Keep ids stable; quote them exactly in edits (`t4`, `d1`, `c3`, node ids).
- If the harness tools return a daemon error, tell the user once and carry on
  in chat. The UI is an aid, not a dependency.
