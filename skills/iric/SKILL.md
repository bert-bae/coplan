---
name: iric
description: The implement → review → refine cycle (iric) for one task of a Managed Coplan build — implement inside the task's scope, run the repository's checks, have it reviewed the way the user chose (a fresh reviewer, self-review, the user, or checks only), refine until it passes, and report each step to the board. Use for every task while building a Managed Coplan plan, or when the user asks to run a task through iric.
---

# iric: implement → review → refine

In a Managed build every task goes round this cycle before it is done. The
point is that no task is marked done on its author's word alone: its checks
passed, and someone looked at it against what it was meant to do. (A
Tracked build leaves how each task is built to you; this cycle is a good
way to do it there too.)

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

Ask the user only as the `coplan` skill's *When to ask* says; in this cycle
that is a task they review, a review round past their limit, and taking a
task whose checks fail.

## 1. Implement

`harness_task_update {task_id, status: "in_progress", stage: "implement"}`

- Build the objective, against the acceptance criteria. Read the boxes it
  builds and what it connects to: your piece has to fit them.
- Stay in scope. Work the brief gives to other tasks is theirs; if you find
  work nobody has, note it for a new task instead of doing it.
- Run the **implement** checks and fix what they find. Report them:
  `harness_task_update {task_id, checks: [{name, ok, note}]}`.

## 2. Review

`harness_task_update {task_id, stage: "review"}` — each time the task goes
into review counts as a round (reporting again while in review does not).

Run the **review** checks first; a review of code that fails its tests is
wasted. Then review the way the brief says:

- **subagent** — a reviewer that did not write the change: a fresh
  subagent where your agent has them, on the model the brief names if it
  names one (the repository's `review.model`); otherwise a cold reread in a
  fresh context. Give it the brief, the diff (`git diff <base>...HEAD`, or
  the working-tree diff of the task's files) and what the brief's *What the
  review checks here* says, if anything. A prompt along these lines works;
  adapt it to the task and to your agent:

  > Review this change against the task brief below, as someone who did
  > not write it: does it meet the objective and each acceptance criterion;
  > is it correct (bugs, edge cases, error handling); does it stay in scope
  > and fit the architecture described; is it tested where it should be?
  > Run the review checks the brief lists. Answer PASS, or CHANGES with the
  > findings, most serious first, each with where and why.

- **self** — read your own diff cold, as that reviewer would, with the
  same questions. Write the findings down before fixing any.
- **user** — the user's by right: summarize the change for them (what it
  does, files, checks) and ask with your question tool (`AskUserQuestion`
  in Claude Code, `request_user_input` in Codex, or plainly in chat) —
  approve, request changes (they say which), or see the diff first. Their
  answer is the review. They can also approve it, or request changes, on
  the task's card in Coplan; that verdict reaches you with your next read
  (and in `harness_task_next`).
- **skip** — the review checks are the review.

Report the review checks and the review's verdict:
`harness_task_update {task_id, checks: [...], verdict: "pass", summary: "<one line>"}`
— or `verdict: "changes"` with what it found, then refine. For a task the
user reviews, only their verdict counts: given in Coplan, or in chat — then
pass it on with `verdict: "pass", user_approved: true` and their words in the note.

## 3. Refine

If the review found anything, or a review check failed:

`harness_task_update {task_id, stage: "refine"}`

- Fix the findings that are in the task's scope. A finding that is really
  another task's work, or new work, becomes a task
  (`harness_plan_edit {ops: [{op: "upsert_task", ...}]}`) — say so in your note.
- If you disagree with a finding, say why in one line; do not just skip it.
- Run the implement checks again, then go back to **2. Review**.

**Round limit.** After `maxRounds` reviews without a pass, another review
is refused: another round is the user's call. Mark the task blocked with a
note on what is still failing, and put it to them — another round, accept
it as it is, or take it over. If they say another round, or accept it,
call `harness_task_update` again with `user_approved: true` and their
answer in the `note`.

## 4. Done

When the review passed and every review check is green (optional checks
aside):

`harness_task_update {task_id, status: "done", note: "<one line: what changed>"}`

Progress is reported only through `harness_task_update`; an
`upsert_task` carrying a status, stage or checks is refused. Checks you
report are merged by name, so the latest result of each counts. Done is
refused before the task has been to review, without a passing verdict for
its last review round (the user's, when they review it), while a check it last
reported fails, or while a required review check was never reported —
refine it. If a failure is unrelated to this task, taking it as it is is
the user's call: mark it blocked with a note saying so.

## The user's control

The user set the defaults when they submitted the plan — who reviews, how
many rounds, how many tasks at once — and may have set a task's own
`review`. What they say in chat overrides both: "show me each task before
it's done" makes every review `user`; "don't bother reviewing the docs
tasks" makes those `skip`. Follow it, and mention it in the task's note.
