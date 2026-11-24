---
name: coplan-config
description: Set Coplan up for a repository so builds are effective and cheap — the repository's checks in .coplan/config.json, and your own build profile (who reviews, on which model, how many tasks at once, how subagents report, and the runners — local, cloud, ssh — a build hands tasks to) in Coplan's coplan.json. Use when the user types /coplan-init or /coplan-config, asks to set up, tune or optimize Coplan, asks to make Coplan builds cheaper, faster or more thorough, or wants to set up where build sessions run.
---

# Setting Coplan up

Two files, two owners:

- **`.coplan/config.json`** in the repository: what "good" means here, the
  same for everyone who builds in it: the checks, the base branch, pull
  requests. Committed.
- **`coplan.json`** in Coplan's home (`~/.claude/cc-harness/`, or
  `$CC_HARNESS_HOME`): how *you* like builds to run in every repository:
  who reviews, on which model, how many tasks at once, standing
  instructions. Not committed.

A repository's file overrides yours key by key, so keep the profile out of
it unless the team wants it shared. `docs/CONFIG.md` in the plugin's folder
has every key. The plugin's folder is two levels up from this file
(`../..`), and the CLI is `bin/coplan` there. Below, `coplan` means that path.

## 1. The checks (the repository)

1. `coplan init --print` shows what Coplan detects from the repository's
   scripts. Check it against how the project is really verified: CI
   (`.github/workflows`, `.gitlab-ci.yml`, …), `package.json` scripts, a
   Makefile, CONTRIBUTING. Put each command where it pays for itself:
   - `implement`: seconds, run after every pass: typecheck, lint, format.
   - `review`: the gate before a task is done: the tests, and whatever CI
     fails on.
   - `final`: once, at the end: the full suite, the build, slow or
     repository-wide checks.
2. Make every check targeted. Checks are the cheapest reviewer there is,
   and a targeted one costs nothing on a change that does not touch it:
   - give each its area (`paths`, or `cwd` for a package),
   - pass changed files where the tool takes them (`eslint {files}`),
   - give slow ones a `timeout`, and mark advisory ones `"optional": true`.
3. Set `branches.base`. Set `"mode": "managed"` rather than `iric`, so the
   user's own profile (step 2) decides how builds run here.
4. If the file exists, show the user how yours differs and ask before
   replacing it. Write it (`//` comments are allowed), run
   `coplan check implement --all --list` to confirm it reads back, and
   suggest committing it.

## 2. The profile (yours)

Use the profile the user named; otherwise **Balanced**, and say they can
switch by telling you. A profile is a few keys in their own file, easily
changed, so it is not worth a question.

| | Lean | Balanced | Thorough |
| --- | --- | --- | --- |
| `iric.review` | `self` | `subagent` | `subagent` |
| `review.model` | — | `sonnet` | `opus` |
| `iric.parallel` | 1 | 2 | 2 |
| `iric.maxRounds` | 2 | 3 | 3 |
| Implementing subagent | `sonnet` | `sonnet`, `opus` for `review: "user"` tasks | the session's model |

Then write `coplan.json`, merging with what is there and keeping the user's
other keys:

```jsonc
{
  "iric": { "review": "subagent", "parallel": 2, "maxRounds": 3 },
  "review": { "model": "sonnet" },
  "instructions": {
    "build": "Hand each task to a fresh background subagent started from this session, with its harness_task_brief as it is, even one at a time: your own context then holds only task status, and every task shows under this session. Run implementing subagents on sonnet; on opus for tasks the user reviews.",
    "brief": "Report back in at most ten lines: the files changed, each check and how it came out, anything left open. No diff, no code."
  }
}
```

Why each choice:

- **Plan on the strongest model.** The design and the task list decide
  everything after them, and a planning session is short. Tell the user to
  plan with the best model they have (`/model opus` in Claude Code).
- **One subagent per task.** Without it, every file read for task 1 is
  still in the main agent's context at task 10, and every turn pays for
  it. The brief is self-contained by design.
- **Implement on a mid model.** A brief with acceptance criteria and checks
  is well specified work. The checks catch what the model misses.
- **Review fresh, not big.** A reviewer that did not write the change finds
  more than a larger model rereading its own work. Spend the strong model on
  the tasks the user marked risky.
- **Short reports.** What a subagent returns is all that enters the main
  context. Ten lines, not a transcript.

Agent differences:

- **Codex and Cursor** cannot pick a subagent's model. Leave out
  `review.model` and the model sentence from `instructions.build`.
- Without subagents, use `iric.review: "self"`, and drop the subagent
  sentence too.
- Say which of these applied.

### Runners (yours)

If the user starts sessions in more than one place — on this machine, in
the cloud, on a machine over ssh — set those up as `runners` in their
`coplan.json` (a repository can add its own in `.coplan/config.json`). Ask
what each is for and how much it can take; write one entry per place:

```jsonc
"runners": {
  "cloud": { "via": "cloud", "use": "Heavy, async, long-running work: set up already", "max": 4 },
  "local": { "via": "local", "use": "Testing and verification I need to reach quickly", "default": true },
  "taovm": { "via": "ssh", "host": "tao-vm", "dir": "~/src/app", "use": "Balanced work on a setup I control", "maxLarge": 2 }
}
```

- `use` is what the build's parent reads to choose a runner for a task the
  user did not place: write it as the user would say it.
- `max` and `maxLarge` are hard limits: the daemon refuses a task past them.
- `start` replaces how `via` starts a session there, the handoff on its
  stdin — needed for a cloud runner used from a local session.
- The user asks for a runner on one task by saying so; you set it as the
  task's `runner` in the plan.

`docs/CONFIG.md` (`runners`) has every key.

## 3. Confirm

Run `coplan doctor`; it reads both files and lists anything wrong in them.
Then tell the user in a few lines:

- what each stage runs,
- which profile they have and where it lives,
- that the Submit dialog can still change review, parallel and rounds for
  one plan, and what they say in chat overrides both.
