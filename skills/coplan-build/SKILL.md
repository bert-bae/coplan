---
name: coplan-build
description: Run the build of a submitted Coplan plan — start tasks only when what they depend on is done, build independent ones side by side where your agent can, land each on its branch (stacked pull requests when branches build on each other), keep the board true, and finish with the final checks and report. Use when a "[cc-harness] Build the plan" prompt arrives, or the user asks to build a Coplan plan.
---

# Building a Coplan plan

The plan is the map; your job is to get every task to done in an order
the dependencies allow, and to keep the board true while you do. You decide
what runs when, and you alone report status to Coplan.

Ask the user only as the `coplan` skill's *When to ask* says. Anything else,
decide, write what you decided in the task's note, and carry on.

## Before you start

If the user told you in chat to build a plan they have not submitted, sign
it off for them first with `harness_plan_advance {to: "build", user_said: "…"}`,
quoting them: the plan locks, the board follows, and the reply is the build
prompt.

The build prompt says how the plan is built:

- **Tracked** — there is no prescribed cycle. Build and check each task as
  you see fit, keep the board true with `harness_task_update`, and read the
  notes in its replies: they say what a Managed build would have held back.
- **Managed** — every task goes implement → review → refine through the
  `iric` skill, and the prompt carries the user's settings:
  - **review** — who reviews a task by default (`subagent`, `self`,
    `user`, `skip`). A task may override it.
  - **parallel** — how many tasks may be in progress at once.
  - **maxRounds** — review rounds a task may take; another past them is
    the user's to allow.

It also lists the repository's **checks** from `.coplan/config.json`, per
stage (`implement`, `review`, `final`). Run those — do not invent others —
with `coplan check`, which runs only the ones for what changed: a task's
checks since the commit it began at (`--since`, given when it starts), the
final ones since the base branch.
A task's brief says which of them the user skipped for it and which they
added for it: follow the brief.
If there are none, pick the repository's own commands (scripts, CI) once,
use them for every task, and say which in your notes.

Call `harness_task_next`. It lists what is ready, what is in progress, what
waits on what, and the branches.

## The loop

Repeat until `harness_task_next` says every task is done:

1. **Pick.** Take ready tasks — in a Managed build, up to `parallel` minus
   those in progress. Ready means everything it depends on is done;
   starting anything else is refused. Do not build two tasks at once in the
   same working tree if they touch the same files (`harness_task_next`
   warns you).
2. **Brief.** Call `harness_task_brief` for each. The brief is
   self-contained: objective, acceptance criteria, the boxes it builds and
   how they connect, what it comes after and before, what is out of
   scope, the branch, and the exact checks.
3. **Start.** `harness_task_update {task_id, status: "in_progress", stage: "implement"}`
   — in a Tracked build the stage is optional.
4. **Build it.** In a Managed build, through the `iric` skill — implement →
   review → refine. In a Tracked build, however suits the task.
5. **Done.** Commit the task's work in whatever granularity the
   repository's history uses, then
   `harness_task_update {task_id, status: "done", note: "<one line: what changed>"}`.
   The reply says what became ready. Go to 1.

## Working in parallel

Use subagents, worktrees and parallel work when your agent has them and
they help: a large plan of independent tasks goes faster side by side, and a
large task kept out of your own context leaves room for the rest. Without
them, build ready tasks one after another — the order is the same.

If you hand a task to a subagent, give it the task's brief as it is; the
brief says where its job ends. Ask it to stay inside that scope, run the
implement checks, and report back to you rather than to Coplan: the files
it changed, the commands it ran and how they came out, and anything left
open. You report its status.

Where parallel tasks work:

- **Different branches** — each in a working tree of its own (a git
  worktree, where your agent offers one), on its task's branch, cut from
  the base the brief names.
- **Same branch, different files** — they may share the working tree.
- **Same branch, same files** — not at the same time. Sequence them.

## Branches and stacked pull requests

If no task names a branch, everything lands on the current branch.
Otherwise:

- Create each branch when its first task starts, from the base the brief
  names: the repository's base branch, or — for a **stacked** branch — the
  branch it builds on.
- When a lower branch changes after a branch above it was cut (a
  refinement, a fix), rebase the branches above onto it before going on.
- A branch built on the tasks with no branch is cut from the branch you
  are on, where those land — the brief says so.
- Open the pull requests the way the build prompt says — the repository
  chooses the tool (`gh`, Graphite, or none) and when (as each branch is
  done, once the user says, or never) in `.coplan/config.json`
  (`pullRequests`). `harness_task_next` lists the branches that are due and
  shows the repository's pull request template, if it has one: write each
  description from it. Each pull request goes against the branch below it
  (the base branch for the bottom one); say in each which tasks it carries
  and what it stacks on, and record it with `harness_branch_update`.
- Where the repository holds the report on its final checks
  (`final.blocking`), the report is refused until it carries each of them,
  passing, in `checks`.

## When things go sideways

- **Blocked** — `harness_task_update {status: "blocked", note}`, saying on
  what. Keep building other ready tasks meanwhile.
- **Work not on the plan** — add it first:
  `harness_plan_edit {ops: [{op: "upsert_task", parentId, title, detail, dependsOn}]}`,
  then build it like any other. It shows as added during the build. Not
  under a task that has already started: add it beside that task, depending
  on it. The tasks the user signed off keep their title, detail, branch and
  review; track them with notes, and if one is wrong, say so in its note.
- **Work no longer needed** — drop it, saying why:
  `harness_task_update {task_id, status: "dropped", note}`. It no longer
  holds anything up; check the tasks that waited on it still have what they
  need, and tell the user. In a Managed build, dropping work the user signed
  off is theirs to decide.
- **A dependency is wrong** (a task really can start earlier, or needs
  something it does not list) — change it with `harness_plan_edit {ops: [{op: "upsert_task", id, dependsOn}]}`
  and tell the user why in chat.
- **The design does not work** — stop that work and tell the user why in
  chat. The plan is locked; only they can reopen it in Coplan.
- **The user says something in chat** — it overrides the settings: if they
  want to see each task, review each with them; if they say go faster, so be it.

## Finish: the final output

When `harness_task_next` says every task is done:

1. Run the **final** checks (`coplan check final`, or the commands the
   prompt lists). Fix what they find — as a task (`upsert_task`), built like
   any other.
2. Push the branches; open the pull requests in stack order if wanted, and
   record each one — `harness_branch_update {branch, pr_url, pr_number, pr_state}`
   — so the board shows the stack. When one merges, record that too: if a
   branch above it now needs rebasing onto the base branch and its pull
   request pointing there, `harness_task_next` says so; do it, then record
   the new `base`.
3. Write the build report — `harness_plan_edit {ops: [{op: "report", text, checks}]}`,
   with the final checks as they came out in `checks` — in markdown. The
   plan is built once the report is in:
   - **Built** — each top-level task, one line each, with its sub-results.
   - **Branches & PRs** — in stack order, with links.
   - **Checks** — the final checks and how they came out.
   - **Changed from the plan** — anything built differently, and why.
   - **Follow-ups** — what was left out of scope, flaky checks, risks.
4. Give the user the same summary in chat, shorter, with the links.
