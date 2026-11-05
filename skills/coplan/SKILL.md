---
name: coplan
description: Plan a task visually in the Coplan UI — architecture diagrams the user reshapes and confirms, then a linked task list (what blocks what, which branch each piece lands on) that the user submits to be built. Use when the user types /coplan or $coplan, asks to "plan this in Coplan" or to set Coplan up, wants to see and shape the plan before work starts, or when a "[cc-harness] The design is confirmed" prompt arrives.
---

# Planning in Coplan

Coplan is a planning workspace in the user's browser. A plan goes through
two sign-offs before anything is built:

1. **The design.** You publish the architecture — diagrams, sections, and
   the tasks you plan, linked to the boxes they build. The user reshapes
   it and **confirms the design**. That locks it.
2. **The task list.** You break the confirmed design into the task list
   the build follows: focused tasks, linked by what blocks what, landing
   on the branches the change needs. The user shapes it and **submits the
   plan**. That starts the build — see the `coplan-build` skill.

**All conversation stays here, in chat.** Coplan never talks to you and
has no way to answer you. When you need a decision, ask it here with your
question tool — `AskUserQuestion` in Claude Code, `request_user_input` in
Codex, the ask-question tool in Cursor — or plainly in chat if you have none.
Coplan shows the question and links the user back to this session to answer
it. When the user has worked over the plan, they tell you so here, and you
read it back.

Each sign-off reaches you as a `[cc-harness]` prompt with the user's next
message in chat — or, in Cursor, they paste it. If they tell you they have
confirmed the design or submitted the plan and no such prompt has reached
you, call `harness_plan_read`: the first read after a sign-off returns its
prompt.

Coplan's tools are the MCP server `harness`: `harness_plan_publish`,
`harness_plan_read`, `harness_plan_edit`, `harness_tasks_publish`,
`harness_task_next`, `harness_task_brief` and `harness_task_update`. Your
agent may show them with a prefix that names the server (in Claude Code,
`mcp__plugin_coplan_harness__…`); they are the same tools.

`harness_plan_edit` takes a list of edits, even for one:
`{ops: [{op: "reply", threadId: "c2", text: "…"}]}`. Each edit takes only
its own fields, and a misspelt one is refused with the right names.

## 1. Investigate, then publish the design

Read the code first. Then call `harness_plan_publish` with:

- **title** and **summary** — what is being built, and the approach in one
  paragraph.
- **diagrams** — the architecture, which is where most design decisions are
  made. Each diagram is `nodes` and `edges`:
  - a node has `id`, `label`, `kind` (`component`, `service`, `datastore`,
    `queue`, `external`, `actor`, `note`), `detail` (a few words on the box:
    technology or role), `description`, `notes` and `taskIds` (the planned
    tasks that build it — the box then shows their progress);
  - an edge has `source`, `target`, optional `label` (what flows along it),
    `dashed` (optional, async or future) and `arrows` (`both` or `none`
    when it is not one-way).

  **Fill in every box as you plan it.** `description` is two to four
  sentences on what the part does, what it owns and how others talk to it.
  `notes` holds what you decided about the part and why, and what you
  ruled out. A box with only a label leaves the user nothing to react to.

  Do not give coordinates or a direction unless you mean it — the UI lays
  diagrams out to fit. One diagram per idea (components, a request's path,
  data flow).
- **tasks** — the *planned* tasks: the main pieces of work, roughly in
  order, each with an `id` the boxes link to. Keep them coarse here; the
  detailed, linked task list comes after the design is confirmed.
- **sections** — supporting prose: Context, Risks, Out of scope. Markdown.

Then ask, with your question tool, whatever you need decided — several
questions at once, with options. Tell the user the design is ready, with the
UI link the publish returned, and that they confirm it in Coplan when it is
right.

## 2. Read it back when they say so

When the user says they have reviewed or changed the plan — or a prompt
arrives with a `[cc-harness]` note that it changed — call `harness_plan_read`.
It leads with the net effect of their edits, then the plan.

- **Their edits** — their structure wins. Work from their diagram and tasks.
- **Comments** — act on each, then reply in its thread with
  `harness_plan_edit {ops: [{op: "reply", threadId, text}]}`; resolve it
  (`{op: "resolve", threadId, resolved: true}`) if settled.

Use `harness_plan_edit` for targeted changes, `harness_plan_publish` only
for a wholesale rewrite (keeping the ids of items that survive). Publishing
is refused while the user has changes you have not read, and so is an edit
to any item (a diagram, section or task) they changed since your last read:
it could undo theirs. Read first, then edit on top of their version.

## 3. Make the task list once the design is confirmed

A `[cc-harness] The design is confirmed …` prompt carries the design. The
architecture, sections and summary are now locked; what you make is the
task list. Publish it with **`harness_tasks_publish`** (it replaces the task
tree and nothing else):

- **Focused tasks.** Break each planned task into pieces with one objective,
  in one area of the architecture, small enough to implement and review on
  their own — a reviewer should be able to judge one without reading the
  others. Nest them under the planned task (keep its id, so its boxes stay
  linked). In `detail`: the objective, the acceptance criteria (how a
  reviewer knows it is right), and what is out of scope. In `files`: the
  files you expect to touch.
- **`dependsOn`** — the ids of tasks that must be done first, because this
  one builds on their result. Only real dependencies: every task left free
  can be built in parallel with the others, by its own subagent. A parent's
  dependencies hold for all its subtasks, so say "the API waits for the
  cache" once, on the parent. No loops.
- **`builds`** — the boxes the task implements (node ids, or
  `diagramId/nodeId`), so the diagram tracks its progress.
- **`branch`** — leave it out when the change is one pull request. When it
  should land as several (separable concerns, a large change, an API before
  its consumers), give each group of tasks a branch. A branch whose tasks
  depend on another branch's is cut from it: a **stacked** pull request. Use
  the repository's base branch and prefix when the prompt names them.
- **`review`** — only when a task needs other than the build's default:
  `"user"` for risky, security-sensitive or user-facing work, `"skip"` for
  trivial mechanical changes.

The read-back then shows the **build order** (steps of tasks that can run
side by side) and the **branches** (how they stack). Check that they say
what you meant. Tell the user the task list is ready to review, and ask
what you need decided. **Do not start building**: the user submits the plan
from Coplan when the tasks are right.

If the prompt says the repository has no `.coplan/config.json`, suggest
setting one up (`coplan init`, or `/coplan-init` in Claude Code) so the
build runs the right checks instead of guessing.

## 4. Build when the user submits the plan

A `[cc-harness] Build the plan …` prompt means the plan is final and
locked. Run the build with the **`coplan-build`** skill, taking each task
through the **`iric`** skill (implement → review → refine). While it is
locked only tracking applies: `harness_task_update`, `upsert_task` for
work you discover, `reply`/`resolve` on comments, and the final `report`.
If the design has to change, stop and ask in chat — the user can reopen it.

If the user tells you to start without submitting, build all the same;
the plan just stays open for them to edit.

## Setting up, and opening Coplan

Coplan's build output is not in its repository: after it is installed or
updated, it has to be built once. If Coplan's tools are missing, or the
user asks you to set Coplan up, run `pnpm install` in the plugin's folder —
two levels up from this file (`../..`) — which builds it; use
`corepack pnpm install` if `pnpm` is not installed. Then tell the user to
restart the agent (or start a new session) so Coplan's tools and hooks load.

The publish result carries the plan's address. To open it in a browser, or
to check the wiring, use the `coplan` CLI: it is `bin/coplan` in the
plugin's folder (`../../bin/coplan` from this file).

- `coplan open` opens this session's plan (and prints the address),
- `coplan doctor` checks the plugin wiring end to end,
- `coplan restart` restarts the daemon after Coplan is updated,
- `coplan check <stage>` runs the repository's checks for a stage.

In Claude Code and Cursor these are also `/coplan-setup`, `/coplan-open`,
`/coplan-doctor`, `/coplan-restart` and `/coplan-init`.

## Rules

- Ask in chat with your question tool, never in the plan. Coplan links the
  user to you; it cannot carry an answer.
- Read before you republish, and never overwrite the user's structure.
- A confirmed design is the user's sign-off on the architecture; a
  submitted plan is their sign-off on the build. Do not redesign either.
- Keep ids stable; quote them exactly (`t4`, `d1`, `c3`, node ids).
- If the Coplan tools return a daemon error, tell the user once and carry on
  in chat. The UI is an aid, not a dependency.
