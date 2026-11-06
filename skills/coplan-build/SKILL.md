---
name: coplan-build
description: Run the build of a submitted Coplan plan — start tasks only when what they depend on is done, build independent ones in parallel with subagents, land each on its branch (stacked pull requests when branches build on each other), take every task through the iric cycle, and finish with the final checks and report. Use when a "[cc-harness] Build the plan" prompt arrives, or the user asks to build a Coplan plan.
---

# Building a Coplan plan

The plan is the map; your job is to get every task to done in an order
the dependencies allow, with each task checked and reviewed, and to keep
the board true while you do. You are the **orchestrator**: you decide what
runs when, hand tasks to subagents, and you alone report status to Coplan.

## Before you start

The build prompt says how the plan is built. In a **Tracked** build there is
no prescribed cycle: build and check each task as you see fit, keep the
board true with `harness_task_update`, and read the notes in its replies —
they say what a Managed build would have held back. The rest of this skill
is how to run a **Managed** build, and a good default for a Tracked one.

In a Managed build the prompt tells you the user's settings — read them,
they are the user's control over the build:

- **review** — who reviews a task by default (`subagent`, `self`, `user`,
  `skip`). A task may override it.
- **parallel** — how many tasks may be in progress at once.
- **maxRounds** — review rounds a task may take before you stop and ask.

It also lists the repository's **checks** from `.coplan/config.json`, per
stage (`implement`, `review`, `final`). Run those — do not invent others.
If there are none, pick the repository's own commands (scripts, CI) once,
use them for every task, and say which in your notes.

Call `harness_task_next`. It lists what is ready, what is in progress, what
waits on what, and the branches.

## The loop

Repeat until `harness_task_next` says every task is done:

1. **Pick.** Take ready tasks, up to `parallel` minus those in progress.
   Ready means everything it depends on is done; starting anything else is
   refused. Do not start two tasks at once in the same working tree if
   they touch the same files (`harness_task_next` warns you).
2. **Brief.** Call `harness_task_brief` for each. The brief is
   self-contained: objective, acceptance criteria, the boxes it builds and
   how they connect, what it comes after and before, what is out of
   scope, the branch, and the exact checks.
3. **Start.** `harness_task_update {task_id, status: "in_progress", stage: "implement"}`.
4. **Build it through the `iric` skill** — implement → review → refine —
   yourself or by subagents (below).
5. **Done.** Once review passed and the review checks are green:
   commit the task's work (one commit per task, message
   `<title> (<task id>)`), then
   `harness_task_update {task_id, status: "done", note: "<one line: what changed>"}`.
   The reply says what became ready. Go to 1.

## Parallel work with subagents

With `parallel` > 1 and several ready tasks, give each its own subagent
(in Claude Code, the Agent tool in the background; whatever your agent
offers for delegating work) and keep working on the others as they run. An
agent without subagents builds ready tasks one after another instead. Each implementer gets the task's brief **verbatim** plus this:

> You are implementing one task of a larger plan. The brief below is your
> whole job: build its objective, stay inside its scope, and run its
> implement checks until they pass. Do not do work the brief gives to other
> tasks — if you find some, list it in your report instead. Do not report
> status to Coplan; report back to me: the files you changed, the commands
> you ran and their results (pass/fail with the failing lines), and
> anything left open or out of scope.

Where they work:

- **Different branches** — each subagent works in its own git worktree
  (in Claude Code, `isolation: "worktree"`), on its task's branch, cut from
  the base the brief names.
- **Same branch, different files** — they may share the working tree; you
  commit each task's files separately once it is reviewed.
- **Same branch, same files** — not in parallel. Sequence them.

Keep the main thread for orchestration: briefs, reviews, status, commits.
With `parallel` = 1, build one task at a time — still through a subagent
for a large task, so its detail does not crowd your context.

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

- **Blocked** — `harness_task_update {status: "blocked", note}` and ask the
  user with your question tool (`AskUserQuestion` in Claude Code,
  `request_user_input` in Codex, or plainly in chat). Keep building other ready tasks meanwhile.
- **Work not on the plan** — add it first:
  `harness_plan_edit {ops: [{op: "upsert_task", parentId, title, detail, dependsOn}]}`,
  then build it like any other. It shows as added during the build. Not
  under a task that has already started: add it beside that task, depending
  on it. The tasks the user signed off keep their title, detail, branch and
  review; track them with notes, and ask if one is wrong.
- **Work no longer needed** — drop it, saying why:
  `harness_task_update {task_id, status: "dropped", note}`. It no longer
  holds anything up; check the tasks that waited on it still have what they
  need, and tell the user.
- **A dependency is wrong** (a task really can start earlier, or needs
  something it does not list) — change it with `harness_plan_edit {ops: [{op: "upsert_task", id, dependsOn}]}`
  and tell the user why in chat.
- **The design does not work** — stop and ask. The plan is locked; the user
  can reopen it in Coplan.
- **The user says something in chat** — it overrides the settings: if they
  ask to see each task, review each with them; if they say go faster, so be it.

## Finish: the final output

When `harness_task_next` says every task is done:

1. Run the **final** checks (`coplan check final`, or the commands the
   prompt lists). Fix what they find — as a task (`upsert_task`), through
   the cycle like any other.
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
