---
name: harness
description: Plan a task visually in the harness UI — architecture diagrams, a task breakdown with subtasks, and the open questions — so the user can reorganize it, comment on it and answer questions in the browser before (and while) you build. Use when the user types /harness, asks to "plan this in the harness", or wants to see and shape the plan before work starts.
---

# Planning in the harness

The harness is a planning workspace in the user's browser. You publish a plan
there; the user reads it as diagrams, a task tree and a set of questions,
reorganizes it, comments on it and answers what you asked. **The conversation
stays here, in chat.** Nothing in the harness waits for the user or talks to
you on its own: when they have worked over the plan, they tell you so here,
and you read it back.

By the end of planning you should hold the architecture, answers to most of
your questions, and a task breakdown to work through.

## 1. Investigate, then publish the plan

Read the code first. Then call `harness_plan_publish` with:

- **title** and **summary** — what is being built, and the approach in one
  paragraph.
- **sections** — the prose a reviewer needs: Context, Architecture, Data
  model, Risks, Out of scope. Markdown. Keep each focused.
- **diagrams** — the design as boxes and arrows. Each diagram is `nodes`
  (`id`, `label`, `kind`, optional `detail`) and `edges` (`source`, `target`,
  optional `label`, `dashed`). Kinds: `component`, `service`, `datastore`,
  `queue`, `external`, `actor`, `note`. Do not give coordinates — the UI lays
  diagrams out and the user arranges them. One diagram per idea (components,
  a request's path, data flow) beats one diagram of everything.
- **tasks** — the breakdown, nested with `subtasks`, in execution order. A
  leaf task is one concrete piece of work; put the approach and acceptance
  criteria in `detail` and the files you expect to touch in `files`.
- **questions** — every decision you need from the user, with `options`
  (`{label, description}`) where the choices are known, `header` as a short
  chip, `context` for what each answer changes, `multiSelect` where several
  apply, and `taskId` when a question holds up a specific task.

Then **tell the user in chat** that the plan is ready — one or two lines on
what to look at first (usually the questions) — and end your turn. Do not
paste the plan into chat; it is in front of them.

## 2. Read it back when they say so

When the user says they have reviewed or changed the plan — or a prompt
arrives with a `[cc-harness]` note that the plan changed — call
`harness_plan_read`. It leads with everything they did since you last read:
answers, moved and added tasks, edited diagrams, comments, and questions they
asked you. Then:

- **Answers** — take them as decisions. Adjust the plan to match.
- **Their edits** — their structure wins. If they moved, nested, added or
  removed tasks, work from their tree, not yours.
- **Comments** — act on each, then reply in its thread with
  `harness_plan_edit` `{op: "reply", threadId, text}` saying what you
  changed or why you disagree. Resolve it if it is settled.
- **Questions they asked you** — answer each with `{op: "answer", id, text}`.

Use `harness_plan_edit` for targeted changes (a batch of ops, applied
together). Use `harness_plan_publish` again only for a wholesale rewrite, and
keep the ids of items that survive so their comments and answers stay
attached. Publishing is refused while the user has changes you have not read
— read first.

Summarize in chat what you changed and what is still open, and end your turn.
Repeat until the open questions are settled and the user is ready.

## 3. Track progress while you build

Once the user says to start, work through the task tree in order and keep
statuses truthful with `harness_task_update`:

- `in_progress` when you start a task,
- `done` with a one-line `note` of what you did,
- `blocked` with a `note` saying what on — and ask the question in chat (or
  add it to the plan with `upsert_question` and `taskId`).

If you discover work that is not on the plan, add it as a task
(`upsert_task` with `parentId`) before doing it, so the breakdown stays the
map of the work.

## Rules

- Converse in chat. The harness is where the plan lives, not where you talk.
- Read before you republish, and never overwrite the user's structure.
- Keep ids stable; quote them exactly in edits (`t4`, `q2`, `d1`, `c3`).
- If the harness tools return a daemon error, tell the user once and carry on
  planning in chat. The UI is an aid, not a dependency.
