---
name: coplan-config
description: Set Coplan up for a repository — the repository's checks in .coplan/config.json, and your own defaults (who reviews a task, standing instructions for the handoff and briefs) in Coplan's coplan.json. Use when the user types /coplan-init or /coplan-config, or asks to set up, tune or optimize Coplan.
---

# Setting Coplan up

Coplan plans and tracks; a harness builds. What it hands over is set in two
files, with two owners:

- **`.coplan/config.json`** in the repository: what "done" means here, the
  same for everyone who plans in it: the checks, the base branch, the pull
  request template. Committed.
- **`coplan.json`** in Coplan's home (`~/.claude/cc-harness/`, or
  `$CC_HARNESS_HOME`): *your* defaults in every repository: the review a
  task asks for, standing instructions. Not committed.

A repository's file overrides yours key by key, so keep your defaults out of
it unless the team wants them shared. `docs/CONFIG.md` in the plugin's
folder has every key. The plugin's folder is two levels up from this file
(`../..`), and the CLI is `bin/coplan` there. Below, `coplan` means that path.

## 1. The checks (the repository)

1. `coplan init --print` shows what Coplan detects from the repository's
   scripts. Check it against how the project is really verified: CI
   (`.github/workflows`, `.gitlab-ci.yml`, …), `package.json` scripts, a
   Makefile, CONTRIBUTING. Put each command under `checks` where it pays
   for itself:
   - `implement`: seconds, run after every pass: typecheck, lint, format.
   - `review`: what a task must pass to be done: the tests, and whatever CI
     fails on.
   - `final`: once, at the end: the full suite, the build, slow or
     repository-wide checks.
2. Make every check targeted, so it costs nothing on a change that does not
   touch it:
   - give each its area (`paths`, or `cwd` for a package),
   - pass changed files where the tool takes them (`eslint {files}`),
   - give slow ones a `timeout`, and mark advisory ones `"optional": true`.
3. Set `branches.base`, and `pullRequests.template` if the repository has
   one.
4. If the file exists, show the user how yours differs and ask before
   replacing it. Write it (`//` comments are allowed), run
   `coplan check implement --all --list` to confirm it reads back, and
   suggest committing it.

## 2. Your defaults

Only if the user wants them. Merge into `coplan.json`, keeping their other
keys:

```jsonc
{
  "review": "agent",
  "instructions": {
    "handoff": "Small commits, each with a message that says why.",
    "brief": "Report back in at most ten lines: the files changed, each check and how it came out, anything left open."
  }
}
```

- **`review`** — what each task asks the harness for: `agent` (a reviewer
  that did not write the change), `user`, or `none` (the checks are the
  review). One task can differ, set in Coplan.
- **`instructions`** — text added to the handoff prompt (`handoff`), every
  task's brief (`brief`), or the prompt that asks for the task list
  (`design`). How the harness builds — models, subagents, how many at once —
  is the harness's own setting, not Coplan's.

## 3. Confirm

Run `coplan doctor`; it reads both files and lists anything wrong in them,
including old keys (`hooks`, `iric`, `mode`, `runners`) it still reads or
ignores, with what to use instead. Then tell the user in a few lines what
each stage runs and where their defaults live.
