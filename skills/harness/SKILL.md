---
name: harness
description: Run a task through the review harness — plan, get the user's approval in the browser UI, implement, publish a diff for line-level review, verify, and ship. Use when the user types /harness, asks to "run this through the harness", or wants to review your work in the UI before it lands.
---

# The review harness

You are driving a task through a browser UI the user has open. They see your
plan, your progress, your diff, and your check results there, and they answer
you from there. Their answers arrive as tool results and as messages in this
conversation.

**Read this once and follow the loop. Do not narrate the mechanics to the user
— they can see everything in the UI.**

## The loop

### 1. Plan

Investigate first, then call `harness_publish_plan` with a title and concrete
steps. The title becomes the PR title later, so make it a real description of
the change.

`harness_publish_plan` opens the **plan gate**. Now **end your turn.** Do not
start implementing, and do not poll — the harness parks the session on the gate
and resumes you the moment the user answers, however long they take.

You come back with one of:

- **approved** — with the user's final step list, which may differ from what
  you published. Their list wins. Implement exactly that.
- **changes_requested** — revise, call `harness_publish_plan` again with the new
  plan, and end your turn again.
- **rejected** — stop and wait for the user's next message.

If a turn ever comes back saying you are *still parked*, the user has not
answered yet: end your turn again straight away, without a tool call.

### 2. Implement — work the board

Approving the plan fills the **task board** automatically: one card per step,
in TODO. The board is what the user watches to see where you are, so keep it
truthful. For each task, in order:

1. `harness_task_update({task_id, status: "in_progress"})` **before you start
   editing.** Files you touch are attributed to whichever task is in progress —
   that is how the board shows what each task changed, and it only works if you
   claim the task first.
2. Do the work. As you go, `harness_task_note({task_id, text})` for anything
   the diff will not explain by itself: a decision you took, a constraint you
   hit, an approach you rejected. Write it while the reason is fresh.
3. **If you hit something you do not know, stop and ask.**
   `harness_task_block({task_id, question, options})` moves the card to BLOCKED
   with your question on it; then end your turn. Their answer comes back as your
   next input and is recorded on the task as a decision automatically. Do not
   guess and carry on — a guess that turns out wrong costs more than the wait.
4. `harness_task_update({task_id, status: "done", note})` — `note` is required
   and says what you actually changed. That record is what the user reviews
   against.

Discovered work that is not on the board goes on it: `harness_tasks({tasks})`.
A task that turns out to be unnecessary gets a note saying why, not a silent
skip.

The user can drag cards too. If one moves, you are told; treat it as direction.

Comments the user writes while you work arrive automatically at the end of your
turn. Act on them when they do.

### 3. Code review

When the work is done, call `harness_publish_diff`. The harness runs git
itself — never paste a diff.

This opens the **code review gate**. End your turn. You are resumed with
comments anchored to specific line ranges, each with the source the user was
looking at and an id in brackets.

For each comment: make the change, then **reply in its thread** with
`harness_reply({thread_id, text})` saying what you changed — or why you
disagree, if you do. A reply in the thread is the only place the user can see
your answer next to what they asked; anything you say only in prose lands in
the activity feed for them to match up by hand.

When every comment has a reply, call `harness_publish_diff` again. The user
gets a "changed since round N" filter, so a second round costs them only the
files that actually moved.

### 4. Verify

Call `harness_publish_checks` with the commands that prove the change works
(`{commands: [...]}`, or omit it to use the project's configured checks). They
run in the UI with streamed output. End your turn to wait for sign-off.

If a check fails, fix it and run again — do not ask the user to sign off on a
red check.

### 5. Ship

Call `harness_ship`. The harness composes the commit message and PR body from
the approved plan, the review threads and the check results. The user confirms
in the UI, choosing the steps and the provider.

If they pick an MCP-backed provider, you receive a directive describing the PR
call to make with that server (Bitbucket, GitLab, …) plus the exact title and
body to use. Make that call, then report the resulting URL with `harness_note`.

## When you need to ask something

**Never end your turn with a question.** The user is looking at the browser,
not the terminal, and a reply they type in the browser cannot start a new turn
— so a question asked in prose can sit unanswered indefinitely.

Call `harness_ask({question, options?})` instead. It opens a gate, shows the
question in the UI with your suggested answers as buttons; end your turn and
you are resumed with what they chose. This applies at every stage, not just
planning.

When the answers are separate decisions, or an option needs explaining, pass
`questions` instead — up to four, each with a short `header`, its own options
as `{label, description}`, and `multiSelect` where more than one can apply:

```
harness_ask({
  question: "How should the cache work?",
  questions: [
    { header: "Backend", question: "Where should it live?", options: [
        { label: "Redis", description: "Shared across processes." },
        { label: "In-memory", description: "Simplest, lost on restart." }] },
    { header: "Eviction", question: "Evict on?", multiSelect: true,
      options: [{ label: "TTL" }, { label: "LRU" }] },
  ],
})
```

The UI renders these as a form and answers every question in one round trip,
which is cheaper than asking three times in a row. The user can always write
their own answer instead of picking one.

## Rules

- **While a gate is open, do not start new work.** End your turn instead: the
  wait costs nothing and the user's answer arrives as your next input. This is
  the whole point of the harness.
- **Do not call `harness_await`.** It is an escape hatch for the rare case
  where you cannot yield the turn; used as a poll it spends a turn per attempt
  to learn nothing.
- **A message from the UI is not a verdict.** The user can write to you while a
  gate is open — answer them, then end your turn to park again.
- Use `harness_note` only for things the user cannot infer from your tool calls
  — a decision you made, a blocker you hit.
- Call `harness_status` when you resume a session and aren't sure whether the
  user is waiting on you.
- Anything you say only in the terminal may never be read. If it needs an
  answer, it belongs in `harness_ask`; if it needs to be seen, `harness_note`.
- If the harness tools return an error about the daemon, tell the user once and
  continue working normally. The UI is an aid, not a dependency.
