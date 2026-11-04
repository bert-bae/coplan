---
name: iric
description: The implement → review → refine cycle (iric) for one task of a Coplan plan — implement inside the task's scope, run the repository's checks, have it reviewed the way the user chose (a fresh subagent, self-review, the user, or checks only), refine until it passes, and report each step to the board. Use for every task while building a Coplan plan, or when the user asks to run a task through iric.
---

# iric: implement → review → refine

Every task goes round this cycle before it is done. The point is that no
task is marked done on its author's word alone: its checks passed, and
someone looked at it against what it was meant to do.

You need the task's brief (`harness_task_brief {task_id}`). It has the
objective and acceptance criteria, the scope, the branch, the review mode,
the round limit, and the exact checks for each stage from
`.coplan/config.json`. Run those checks — they are what the repository
says "good" means. `coplan check <stage> --files <the task's files>` runs a
whole stage at once; add `--json` to get results in the shape
`harness_task_update` takes.

Report every step with `harness_task_update` so the board shows where the
task is. If you are a subagent without the Coplan tools, report back to the
agent that briefed you instead, and it reports.

## 1. Implement

`harness_task_update {task_id, status: "in_progress", stage: "implement"}`

- Build the objective, against the acceptance criteria. Read the boxes it
  builds and what it connects to: your piece has to fit them.
- Stay in scope. Work the brief gives to other tasks is theirs; if you find
  work nobody has, note it for a new task instead of doing it.
- Run the **implement** checks and fix what they find. Report them:
  `harness_task_update {task_id, checks: [{name, ok, note}]}`.

## 2. Review

`harness_task_update {task_id, stage: "review"}` — each time counts as a
round.

Run the **review** checks first; a review of code that fails its tests is
wasted. Then review the way the brief says:

- **subagent** — a fresh subagent that did not write the change. Give it
  the brief and the diff (`git diff <base>...HEAD`, or the working-tree diff
  of the task's files) and this:

  > Review this change against the task brief below. You did not write it;
  > read it as its reviewer. Check, in order: (1) does it meet the
  > objective and every acceptance criterion; (2) is it correct — bugs,
  > edge cases, error handling, concurrency; (3) does it stay in scope and
  > fit the architecture described (the boxes, their decisions, their
  > connections); (4) is it tested where it should be. Run the review
  > checks listed in the brief. Answer with **PASS**, or **CHANGES** and a
  > numbered list of findings — each with the file and line, what is wrong,
  > and why it matters — most serious first. Do not fix anything, and do
  > not list style preferences the repository's tools do not enforce.

- **self** — read your own diff cold, as that reviewer would, with the
  same four questions. Write the findings down before fixing any.
- **user** — summarize the change for the user (what it does, files,
  checks) and ask with `AskUserQuestion`: approve, request changes (they
  say which), or see the diff first. Their answer is the review.
- **skip** — the review checks are the review.

Report the review checks: `harness_task_update {task_id, checks: [...]}`.

## 3. Refine

If the review found anything, or a review check failed:

`harness_task_update {task_id, stage: "refine"}`

- Fix the findings that are in the task's scope. A finding that is really
  another task's work, or new work, becomes a task
  (`harness_plan_edit {op: "upsert_task", ...}`) — say so in your note.
- If you disagree with a finding, say why in one line; do not just skip it.
- Run the implement checks again, then go back to **2. Review**.

**Round limit.** After `maxRounds` reviews without a pass, stop. Mark the
task blocked with a note on what is still failing, and ask the user with
`AskUserQuestion`: another round, accept it as it is, or take it over.

## 4. Done

When the review passed and every review check is green (optional checks
aside):

`harness_task_update {task_id, status: "done", note: "<one line: what changed>"}`

Marking a task done while its last reported checks fail is refused —
refine it, or, if the failure is unrelated to this task, mark it blocked
and ask.

## The user's control

The user set the defaults when they submitted the plan — who reviews, how
many rounds, how many tasks at once — and may have set a task's own
`review`. What they say in chat overrides both: "show me each task before
it's done" makes every review `user`; "don't bother reviewing the docs
tasks" makes those `skip`. Follow it, and mention it in the task's note.
