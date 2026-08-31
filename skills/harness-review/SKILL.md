---
name: harness-review
description: Publish the current changes to the review UI for line-level comments, and act on the comments that come back. Use when the user asks to "review this in the UI", wants to look at the diff before committing, or after finishing an implementation that wasn't already running under /harness.
---

# Review the changes in the UI

Use this when the work already exists and the user wants to look at it — no
plan gate needed.

## Publish

Call `harness_publish_diff`. The harness runs git and renders the result in the
browser. Pass `base_ref` only if the user named a specific base; otherwise the
harness picks the merge-base with the default branch, falling back to the
commit the session started at.

This opens the code review gate.

## Wait

Call `harness_await`. If it returns `pending`, call it again — the user is
still reading. If it returns `interrupted`, they closed the review gate and
sent a message instead: act on that message rather than waiting for a verdict
that is no longer coming.

## Act on what comes back

Each comment carries `file:startLine-endLine`, the source lines the user
selected, and their note. Work through them in file order:

- **Fix it** when the comment identifies a real problem. Make the change.
- **Push back** when the comment rests on a wrong premise — say so plainly in
  one or two sentences, with the evidence, and leave the code alone. Do not
  silently comply with a change you believe is wrong.
- **Ask** only when a comment is genuinely ambiguous and the readings lead to
  different code.

Reply to every comment in its own thread with
`harness_reply({thread_id, text})` — the id is in brackets at the start of each
comment you were given. Say what you changed, or why you disagree. Then call
`harness_publish_diff` again so the user re-reviews. Repeat until they approve.

## Then

If the user wants to land the change, continue with `harness_publish_checks`
and `harness_ship` — see the `harness` skill for the full loop.
