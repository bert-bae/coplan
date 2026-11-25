---
name: coplan-handoff
description: Build a submitted Coplan plan from its handoff and report back — take ready tasks from harness_task_next, build each from its harness_task_brief, and record each task, branch and the build report so the board stays true. Use when a "[cc-harness] Build the plan" prompt arrives, or the user asks to build a Coplan plan.
---

# Building from a Coplan handoff

Coplan plans and tracks; it does not build. A submitted plan is locked and
handed to a harness — this session, firstmate, any agent — with one prompt.
The harness builds however it works and reports back, and Coplan records
what it reports. It refuses only malformed input, starting a task before
what it depends on is done, and a verdict outside a review.

Ask the user only as the `coplan` skill's *When to ask* says. Anything else,
decide, write what you decided in the task's note, and carry on.

If the user told you in chat to build a plan they have not submitted, record
it first with `harness_plan_advance {to: "build", user_said: "…"}`, quoting
them: the plan locks, and the reply is the handoff prompt.

## The loop

Read the handoff prompt: the checks, the review each task asks for, the
branches, the standing instructions. Then repeat until `harness_task_next`
says every task is done:

1. **Next.** `harness_task_next` lists the ready tasks, what the rest wait
   on, and the branches.
2. **Brief.** `harness_task_brief {task_id}`: the objective, where it fits,
   its branch, its checks and review, and a **Done when** section. It is
   self-contained: hand it as it is to whoever builds the task.
3. **Build** it however your harness works. Report as you go with
   `harness_task_update {task_id, …}`:
   - `status: "in_progress"` (or a `stage`: `implement`, `review`, `refine`)
     when it starts;
   - `checks: [{name, ok, note}]` as they come out — `coplan check <stage>
     --json` runs the repository's and prints them;
   - `verdict: "pass" | "changes"` with a `summary` once a review is in
     (`user_approved: true` when the user gave it in chat);
   - `status: "done"`, `"blocked"` or `"dropped"` with a one-line `note`:
     what changed, what it waits on, or why it is no longer needed.

When this session is the harness and there is no other, build the tasks one
by one yourself, each until its brief's **Done when** holds.

## Along the way

- **Work not on the plan** — add it first, then build it like any other:
  `harness_plan_edit {ops: [{op: "upsert_task", parentId, title, detail, dependsOn}]}`.
  Put it beside a task that has already started, not under it.
- **Branches and pull requests** — land each task on its brief's branch; cut
  a stacked branch from the one it builds on. Record each pull request and
  its later state with `harness_branch_update {branch, pr_url, pr_number, pr_state, base}`.
- **The design does not work** — stop that work and tell the user why in
  chat. The plan is locked; only they can reopen it in Coplan.

## Finish

When every task is done, run the final checks (`coplan check final`) and
write the report — `harness_plan_edit {ops: [{op: "report", text, checks}]}`
— in markdown: what was built, the branches and pull requests, the checks
and how they came out, what changed from the plan, and follow-ups. Give the
user the same summary in chat, shorter, with the links.
