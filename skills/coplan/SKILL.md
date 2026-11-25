---
name: coplan
description: Plan a task visually in Coplan — architecture diagrams the user confirms, then a linked task list, or straight to the task list — built when the user says so. Takes --architect, --tasklist and --headless (no browser: the plan as a page published as an Artifact, or a Markdown file). Use when the user types /coplan or $coplan, asks to "plan this in Coplan" or to set Coplan up, wants to see and shape the plan before work starts, tells you to go ahead with a Coplan plan, or when a "[cc-harness] The design is confirmed" or "[cc-harness] Revise the plan" prompt arrives.
---

# Planning in Coplan

Coplan is a planning workspace in the user's browser. Every plan ends in a
task list, and the task list in the build. It takes one of two modes:

- **Architecture first** (`mode: "architect"`) — two sign-offs:
  1. **The design.** You publish the architecture — diagrams, sections,
     and the task ideas, linked to the boxes they build. The user reshapes
     it and **confirms the design**. That locks it.
  2. **The task list.** You break the confirmed design into the task list
     the build follows: focused tasks, linked by what blocks what, landing
     on the branches the change needs. The user shapes it and **submits
     the plan**. That hands it to the build — see the `coplan-handoff` skill.

  The task list is never made before the design is confirmed, and the plan
  is not built before there is a task list: Coplan refuses both.
- **Straight to the task list** (`mode: "tasklist"`) — one sign-off: you
  publish the task list itself, the user shapes it and **submits the plan**.

The user signs off either way: **in Coplan**, with *Confirm design* or
*Submit*, or **here in chat**, by telling you to go ahead.

## Choosing the mode

The user may say: `/coplan --architect …` or `/coplan --tasklist …`. If
they do not, choose:

- **Architect** when the change spans several systems, services or
  repositories, reshapes a product flow, a workflow or a user journey, or
  when the user (a system architect, a product owner) needs to see how the
  parts fit before the work is split up. A picture of it is how they check
  you understood.
- **Tasklist** when the work is targeted: one area of the code, a bug, a
  refactor, a feature inside one component — where a diagram would only
  restate the file list. It is the faster path: use it whenever an
  architecture adds nothing.

Say which you chose, and why, in the summary. If the user asks for the
other, publish again with that mode.

## Headless: `--headless`

When the user passes `--headless`, they cannot reach Coplan's page — you run
as a cloud agent or on a virtual machine. The plan reaches them as a **page
you publish as an Artifact**, if you have an Artifact tool (Claude Code on
the web does), or else as a Markdown file. The page is read-only: an
Overview, each diagram drawn as a picture, and the task list, with the ids
the user names in chat. Everything is said in chat: they tell you what to
change, and they sign off by telling you to go ahead.

**With Coplan's tools.** Pass `headless: true` on your first
`harness_plan_publish`. Coplan never opens the page; it keeps the plan in the
working directory as `.coplan/plans/<session>.md` and `.html` (the publish
reply names them) and rewrites both whenever the plan changes, through the
build. Publish the `.html` with your Artifact tool and give the user its link;
publish the same file again after every change — an edit, a sign-off, the
task list, a task done in the build — so the link stays current. With no
Artifact tool, give them the `.md` path. Make their changes with
`harness_plan_edit` (its `propose` op is refused: there is no page to
accept it on) and record their sign-off with `harness_plan_advance`.

**Without Coplan's tools** — its MCP server did not connect, or its tools
return a daemon error — make the page yourself from the template, and keep
the plan in it:

1. Copy `dist/artifact/plan.html` from the plugin's folder (`../..` from this
   file) to `.coplan/plans/<short-name>.html`, and read it once.
2. Replace `null` in `<script type="application/json" id="plan">null</script>`
   with the plan as JSON: what `harness_plan_publish` takes (`title`, `mode`,
   `summary`, `sections`, `diagrams`, `tasks`, an `id` on every task and box),
   plus `"agent": "Claude"`. Write `<` as `\u003c` inside it. Put the plan's
   title in `<title>`. Change nothing else in the file.
3. Publish it with your Artifact tool and give the user the link. To revise,
   edit the JSON and publish the same file again.
4. When they go ahead, add their sign-off, quoting them —
   `"design": {"userSaid": "…", "at": "<ISO time>"}` for the design (then
   replace `tasks` with the task list made from it, as *step 3* says), or
   `"submission": {…}` to build — and publish again before you act on it.
5. While you build, keep each task's `status` (`todo`, `in_progress`,
   `blocked`, `done`, `dropped`) and `note` current and publish as tasks
   finish; end with `"report": {"text": "…"}`. Build in the order the page
   shows, each task on its branch, and check each as the repository's
   checks allow.

If the user comments on the Artifact and sends the comment to you, it is
their word like a chat message: act on it, answer it, publish again.

- **In Coplan**, the sign-off reaches you as a `[cc-harness]` prompt with
  their next message in chat — or, in Cursor, they paste it. If they tell
  you they have confirmed the design or submitted the plan and no such
  prompt has reached you, call `harness_plan_read`: the first read after a
  sign-off returns its prompt.
- **In chat**, you decide whether what they said means go ahead — "looks
  good, build it", "make the task list" — and record it with
  `harness_plan_advance {to: "tasks", user_said: "…"}` to make the task
  list, or `harness_plan_advance {to: "build", user_said: "…"}` to build,
  quoting their words. It signs the plan off as the page would, locks it,
  and returns the prompt
  the page would have sent: act on it at once, with no further question.
  Their word is enough; there is no need to send them to Coplan to click.

Coplan's tools are the MCP server `harness`: `harness_plan_publish`,
`harness_plan_read`, `harness_plan_check`, `harness_plan_edit`, `harness_plan_advance`, `harness_tasks_publish`,
`harness_task_next`, `harness_task_brief`, `harness_task_update` and `harness_branch_update`. Your
agent may show them with a prefix that names the server (in Claude Code,
`mcp__plugin_coplan_harness__…`); they are the same tools.

`harness_plan_edit` takes a list of edits, even for one:
`{ops: [{op: "reply", threadId: "c2", text: "…"}]}`. Each edit takes only
its own fields, and a misspelt one is refused with the right names.

## When to ask

This is the one rule for asking the user anything, in every step below.
Ask only when a decision:

- **cannot be undone**,
- **reaches outside this session** — pushing, opening a pull request,
  anything other people will see — or
- **is the user's by right** — a task they asked to review themselves.

Anything else, decide, write the decision where the user will see it — a
box's notes or a section while you design, a task's detail while you make
the task list, the task's note while you build — and carry on. The user
reviews the design and the task list before anything is built, and changes
what they disagree with.

When you do ask, ask here in chat with your question tool —
`AskUserQuestion` in Claude Code, `request_user_input` in Codex, the
ask-question tool in Cursor — or plainly if you have none: everything
pending at once, with options. **All conversation stays here.** Coplan never
talks to you and cannot carry an answer: it shows the question and links the
user back to this session to answer it. When the user has worked over the
plan, they tell you so here, and you read it back.

## 1. Investigate, then publish the plan

Read the code first. Then call `harness_plan_publish` with:

- **mode** — `architect` or `tasklist` (see *Choosing the mode*).
- **title** and **summary** — the summary is the first thing the user
  reads: your understanding of the problem (what is asked, what you found
  in the code that bears on it), how you are approaching it, and why
  architecture first or straight to tasks. A short paragraph or two.

For a **tasklist** plan, give `tasks` as the task list itself, made as
*step 3* says — focused tasks with `detail`, `files`, `dependsOn` and
`branch` — and no diagrams; skip to *step 3*'s last paragraph for the
checks, and tell the user the task list is ready to review. For an
**architect** plan:

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
- **tasks** — the *task ideas*: the main pieces of work, roughly in
  order, each with an `id` the boxes link to, so the diagram shows how the
  task list will follow from it. Keep them coarse here; the detailed,
  linked task list comes after the design is confirmed — never before.
- **sections** — supporting prose: Context, Risks, Out of scope. Markdown.

Run `harness_plan_check` and fix what it finds — a box with no
description, a planned task that builds no box — or say in chat why a gap
stays. Where the code and the request leave a choice open, make it and write
it on the box it is about (see *When to ask*). Tell the user the design is
ready, with the UI link the publish returned (the Artifact link, when headless), and
that when it is right they confirm it — in Coplan, or by telling you here —
and you make the task list from it.

## 2. Read it back when they say so

When the user says they have reviewed or changed the plan — or a prompt
arrives with a `[cc-harness]` note that it changed — call `harness_plan_read`.
It leads with the net effect of their edits, then the plan. Once the whole
plan is in your context, read with `{changes_only: true}`: only what changed
and what waits on you, a fraction of the size. Read it whole again only if
the plan has left your context.

- **Their edits** — their structure wins. Work from their diagram and tasks.
- **Comments** — act on each, then reply in its thread with
  `harness_plan_edit {ops: [{op: "reply", threadId, text}]}`; resolve it
  (`{op: "resolve", threadId, resolved: true}`) if settled.

A `[cc-harness] Revise the plan …` prompt is the user asking, from Coplan,
for exactly that: it lists the comments waiting on you. Act on each, reply in
its thread, propose what is theirs to decide, then tell them what changed.
Coplan marks their ask answered once every comment has a reply or a
proposal.

**Open decisions.** Whatever is the developers' to decide — a trade-off, a
product choice, a constraint you cannot see — is never yours to settle. Raise
each as a decision, before you ask to confirm the design or the task list:
`harness_plan_edit {ops: [{op: "comment", target: {kind: "plan", id: ""},
text: "<the question, with what each choice costs>", decision: ["A", "B"]}]}`
(`decision: []` for an open question). Coplan shows them in a section at the
top of the Overview; the user answers and sends them, and a `[cc-harness]
Revise the plan` prompt brings the answers back: revise the architecture and
tasks to follow them, reply in each thread and resolve it. An answer can raise
a new decision; ask it the same way.

**Headless**, the user has no page: do not open decision threads. Interview
them in chat instead, **one decision at a time** — give the context, the
choices and your recommendation, then wait for the answer before asking the
next. Then revise the architecture and tasks from the answers, and record
each in a "Decisions" section of the plan.

**Auditing the plan.** When you review the design — yours or the user's —
and are not sure a change is wanted, say so where it applies instead of
overwriting: `harness_plan_edit {ops: [{op: "comment", target: {kind: "node",
id: "d1/cache"}, text: "Should this be write-through? Reads lag writes by
the TTL."}]}`. A target is the plan (`{kind: "plan", id: ""}`), a section,
a diagram or a task by id, or one box (`node`, `"diagramId/nodeId"`) or
arrow (`edge`, `"diagramId/edgeId"`). The user answers in the thread.

When you know the change you would make and it is the user's to decide —
a design flaw your audit found, a part the plan is missing, a task to
split — **propose it** instead of making it: `harness_plan_edit {ops: [{op: "propose",
title, reason, ops}]}`, alone in the call, with the same edits as a normal call. The user sees it
in Coplan beside what it changes, with your reason, and accepts it (the
edits apply, as theirs) or rejects it. Nothing changes until they answer;
`harness_plan_read` tells you how they did, once. Propose too once the
design is confirmed or the plan submitted, for what you may no longer
change yourself. A proposal goes out of date if what it changes moves
first: withdraw it (`{op: "withdraw_proposal", id}`) and propose again.
Keep each to one idea, so it can be taken or left whole.

A subagent that audits the plan for you reads it with
`harness_plan_read {peek: true}`: it sees the plan as it stands, but the
user's changes stay unread, so your next read still reports them to you.

The read gives each section, diagram and task its revision (`rev`). Pass
it as `expect` on an `upsert_section`, `upsert_diagram` or `upsert_task` to
have the edit refused if the user changed that item since.

Use `harness_plan_edit` for targeted changes, `harness_plan_publish` only
for a wholesale rewrite (keeping the ids of items that survive). To change
one box or arrow, use `upsert_node`, `remove_node`, `upsert_edge` or
`remove_edge` rather than restating the whole diagram:
`harness_plan_edit {ops: [{op: "upsert_node", diagramId: "d1", id: "cache",
description: "…"}]}` changes that box's description and nothing else. Publishing
is refused while the user has changes you have not read, and so is an edit
to any item (a diagram, section or task) they changed since your last read:
it could undo theirs. Read first, then edit on top of their version.

## 3. Make the task list once the design is confirmed

A `[cc-harness] The design is confirmed …` prompt carries the design — with
the user's next message, or as `harness_plan_advance {to: "tasks", user_said}`'s
answer when they confirmed it in chat. The
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
  can be built alongside the others. A parent's dependencies hold for all
  its subtasks, so say "the API waits for the cache" once, on the parent.
  No loops.
- **`builds`** — the boxes the task implements (node ids, or
  `diagramId/nodeId`), so the diagram tracks its progress.
- **`branch`** — leave it out when the change is one pull request. When it
  should land as several (separable concerns, a large change, an API before
  its consumers), give each group of tasks a branch. A branch whose tasks
  depend on another branch's is cut from it: a **stacked** pull request —
  and one whose tasks depend on tasks with no branch is cut from the branch
  you are on. A pull request has one base, so a branch cannot need work
  from two branches that do not stack: that is refused, and you either put
  the work on one branch or make one stack on the other. Use the
  repository's base branch and prefix when the prompt names them.
- **`review`** — only when a task needs other than the build's default:
  `"user"` for risky, security-sensitive or user-facing work, `"none"` for
  trivial mechanical changes.
- **Its checks** are the repository's. Which checks a task runs is the
  user's alone: when one should skip a check (a docs-only task, the test
  suite) or needs one of its own (a migration, `pnpm db:check`), propose it —
  `harness_plan_edit {ops: [{op: "propose", title, reason, ops: [{op: "set_checks", id, skip: ["tests"]}]}]}`
  (or `add: [{name, run, stage}]`) — and the user accepts it in Coplan.

The read-back then shows the **build order** (steps of tasks that can run
side by side) and the **branches** (how they stack), and the reply lists
the **gaps** the list leaves open (`harness_plan_check` lists them any
time): tasks with no detail, boxes no task builds, branches a stack of pull
requests cannot follow. Check they say what you meant, and fix or explain
each gap. Tell the user the task list is ready to review. In a tasklist plan
this is the first thing the user sees. **Start building
when they say so**: told here in chat, call
`harness_plan_advance {to: "build", user_said: "…"}` and build from the
prompt it returns; submitted in Coplan, the build prompt reaches you.

If the prompt says the repository has no `.coplan/config.json`, suggest
setting one up (`coplan init`, or `/coplan-init` in Claude Code) so the
build runs the right checks instead of guessing.

## 4. Build when the user says so

A `[cc-harness] Build the plan …` prompt means the plan is final and
locked: it comes with the user's next message once they submit in Coplan,
or as `harness_plan_advance {to: "build", user_said}`'s answer when they said so
in chat — from the task list, or straight from the design. Coplan plans
and tracks; a harness builds. If you are the harness, follow the
**`coplan-handoff`** skill. While the plan is locked only tracking applies:
`harness_task_update`, `harness_branch_update`, `upsert_task` for work you
discover, `reply`/`resolve` on comments, and the final `report`. If the
design has to change, stop that work and tell the user why in chat: only
they can reopen it.

When the user tells you to build, record it with `harness_plan_advance`
before you start, so the plan locks and the board follows the build. In an
architect plan whose design is not confirmed yet, "build it" confirms the
design: advance `to: "tasks"` with their words, make the task list, and
build once they have seen it.

## Setting up, and opening Coplan

Coplan is installed with `npx coplan@latest setup`, or from a clone of its
repository with `./setup.sh`.
The plugin's folder is two levels up from this file (`../..`). If the user
wants you to set Coplan up, update it, or change its settings:

- If that folder holds `install.json`, the setup installed it, already
  built. Tell the user to run the command `install.json` names in `update`
  (older copies: `./setup.sh` in the `clone` it names, after a `git pull`),
  in a terminal: it is interactive, so do not run it for them.
- Otherwise it is a checkout loaded directly. If it has no `dist/`, Coplan's
  tools are missing because it was never built: run `pnpm install` there,
  which builds it (`corepack pnpm install` if `pnpm` is not installed).

Then tell the user to restart the agent (or start a new session) so Coplan's
tools and hooks load.

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

- Ask only as *When to ask* says, in chat, never in the plan. Coplan links
  the user to you; it cannot carry an answer.
- Read before you republish, and never overwrite the user's structure.
- A confirmed design is the user's sign-off on the architecture; a
  submitted plan is their sign-off on the build. Do not redesign either.
- Sign off for the user (`harness_plan_advance`) only on their word in
  chat, and quote it.
- Keep ids stable; quote them exactly (`t4`, `d1`, `c3`, node ids).
- If the Coplan tools return a daemon error, tell the user once and carry on
  in chat — headless, with the page you make yourself. The UI is an aid, not
  a dependency.
