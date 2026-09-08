---
name: harness-ship
description: Run the verification and ship stages in the review UI — run the project's checks, then commit, push and open a PR through the configured provider (gh, Bitbucket MCP, or a custom command). Use when the user asks to ship, land, open a PR, or "finish this up".
---

# Verify and ship

## 1. Verify

Call `harness_publish_checks`.

- Omit `commands` to run whatever the project configured in
  `.claude/harness.json`.
- Pass `{commands: [...]}` when you know better ones — the actual typecheck,
  lint and test commands for this repo, discovered from `package.json`,
  `Makefile`, or the project's CLAUDE.md.

Output streams into the UI as it runs. The call does not return until every
check has finished, and it tells you which ones failed and why — the gate only
opens once there is a real result to sign off on.

**If checks failed, fix them and call `harness_publish_checks` again.** Do not
end your turn on a red check: the user has nothing useful to say about a
failure you already know how to fix.

## 2. Ship

Call `harness_ship`. The harness composes the commit message, PR title and PR
body from the approved plan, the review threads and the check results, and
opens the ship gate. The user picks the steps (checks, commit, push, pr,
summary) and the provider, edits the text if they want, and confirms.

Then end your turn. The harness holds it open briefly, so a confirmation that
comes straight away resumes you with the result; otherwise the session stops at
the ship gate and their decision is handed to you when they next speak to it.

## 3. Finish the provider call, if it is yours to make

Two kinds of provider exist:

- **Command providers** (`gh` by default) run in the daemon. The PR is already
  open by the time you hear back — you have nothing left to do.
- **MCP providers** (Bitbucket, GitLab, Linear, …) cannot be run by the daemon,
  because those servers are connected to *this session*. You receive a
  directive with the exact title, body, source branch and target branch. Make
  that MCP call yourself, then report the resulting URL with `harness_note`.

## Notes

- The user's confirmed steps are authoritative. If they unchecked `push`, do
  not push.
- If a step fails, the harness stops there and reports why. Fix the cause and
  call `harness_ship` again rather than working around it by hand.
- The default providers, the step list and the summary path all live in
  `~/.claude/cc-harness/config.json`, overridable per repo in
  `.claude/harness.json`.
