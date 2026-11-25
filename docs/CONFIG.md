# Configuration

Three layers, merged in order:

1. the defaults in the table below
2. user global — `~/.claude/cc-harness/config.json`
3. project — `<repo>/.claude/harness.json`

`./setup.sh` can set the main ones for you — answer yes to *Adjust settings
now?* — along with [your plan defaults](#your-own-defaults-coplanjson) and a
[repository's checks](#the-repository-coplanconfigjson). Everything else is
set here, by hand.

Later layers override earlier ones key by key, except `idleShutdownMinutes`,
which only the global file sets: one daemon serves every repository. An edit
to either file counts at once, with no restart.

Both files are JSON with comments: `//` to the end of a line and `/* … */`
anywhere outside a string, and a trailing comma is allowed. Nothing is
skipped silently: a file that is not valid JSON, a key Coplan does not read,
or a value of the wrong type or out of range is written to `daemon.log`,
reported by `coplan doctor`, and shown in the Coplan page of every session
that reads the file (a toast once per distinct error, and **⚠ settings** in
the rail's footer until it is fixed); the value from the layer before is
used.
The keys the old review loop used (`gateHoldSeconds`, `stages`, `ship`) are
still ignored without a word, so an old config file does no harm.

| Key | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `false` | Open the plan in a browser the first time Claude publishes one in a session. Off by default: the plugin is installed globally, and a tool should not open windows you did not ask for. Use `/coplan-open`, `coplan open`, or the URL the tools print. |
| `promptNotice` | `true` | When you type in Claude's chat after changing the plan in the browser, add one line to the prompt telling Claude to call `harness_plan_read`. Turn it off if you would rather always say so yourself. It does not affect the handoff prompt: submitting a plan for this session is itself the request to send it. |
| `openClaudeOnQuestion` | `false` | When the agent asks you something (`AskUserQuestion` or `request_user_input`, or a permission prompt), open that session in its desktop app straight away instead of waiting for you to click *Answer in …*. Works for a local Claude Code session with Remote Control on and for a Codex thread (in the Codex app): those are the only local sessions with a documented link, and a cloud session's daemon has no screen to open anything on. Cursor has no link to a chat, so it is never opened. |
| `idleShutdownMinutes` | `120` | Exit after this long with no active session and no browser attached. The next hook starts a fresh daemon. `0` disables it. A whole number, 0 or more; global file only. |

## Files

Everything lives under `~/.claude/cc-harness` (override with
`CC_HARNESS_HOME`), whichever agent the session runs in. Codex hands
`CC_HARNESS_HOME` on to Coplan's MCP server. Cursor gives MCP servers only a
fixed environment, so Coplan's tools in Cursor always use the default
directory: leave `CC_HARNESS_HOME` unset when you use Cursor.

| Path | What it is |
| --- | --- |
| `daemon.json` | The running daemon's address and token. |
| `daemon.log` | The daemon's log; trimmed by `coplan clean`. |
| `sessions/<id>/state.json` | One session's plan, change log, comments and — once signed off — the prompts it was confirmed and submitted with. Kept 30 days after its last change. |
| `config.json` | Your global configuration. |
| `coplan.json` | Your own defaults for every repository's plans: the keys of `.coplan/config.json` below, except `checks`. See [Your own defaults](#your-own-defaults-coplanjson). |
| `instructions/<point>.md` | Your own standing instructions, for `design`, `handoff` or `brief`: the same as `instructions` in `coplan.json`. |

## The repository: `.coplan/config.json`

The settings above are about Coplan on your machine. What a task must pass
to be done belongs to the repository, so it lives with the code — committed,
so every plan there hands over the same checks: `<repo>/.coplan/config.json`. Comments
and trailing commas are allowed, as above. `coplan init` (or `/coplan-init`
in Claude) writes a starting point from the repository's scripts, and so does
`./setup.sh` when you give it the repository's path.

```jsonc
{
  "checks": {
    "implement": ["pnpm run typecheck", { "name": "ruff", "run": "ruff check .", "paths": ["*.py"] }],
    "review": [{ "name": "tests", "run": "pnpm run test", "timeout": 900 }],
    "final": ["pnpm run check", { "name": "audit", "run": "pnpm audit", "optional": true }]
  },
  "review": "agent",
  "branches": { "base": "main", "prefix": "coplan/" }
}
```

Coplan plans and tracks; a harness builds. Every key here describes *what*
to build or *what done means*, and goes to the harness as plan data in the
handoff and each task's brief. Keys that decided *how*, *where* or *when*
work runs, or enforced that it ran, are deprecated: from 0.4 they are
ignored, with a `coplan doctor` warning, for one release, like
`gateHoldSeconds`, `stages` and `ship` before them.

### `checks`

Each task's definition of done: the checks the harness runs, by stage. Every
brief lists them; the harness reports what it ran with
`harness_task_update`, and the board and the build report show what it
reported. Coplan does not refuse `done` over them.

| Stage | What it means |
| --- | --- |
| `implement` | Quick checks after each change: typecheck, lint, format. Keep them to seconds. |
| `review` | What a task must pass to be done: the tests, and anything CI would fail on. |
| `final` | Once every task is done, before the build report: the full suite, the build, repository-wide checks. |

A check is a command, run from the repository root, or an object:

| Key | Meaning |
| --- | --- |
| `run` | The shell command. Required. `{files}` in it is the changed files in the check's area, each quoted (`ruff check {files}`, `eslint {files}`), so the tool looks at nothing else; from the check's `cwd` when it has one. Where the change is not known, or runs past 1,000 files, it is `.`, the whole repository. |
| `name` | What it is called in reports and on the board, up to 60 characters. Defaults to the script name (`pnpm run lint` → `lint`). |
| `timeout` | Seconds before `coplan check` stops it: 1 to 3600. Default 600. |
| `paths` | Globs (`src/**`, `*.py`, `docs/`, `src/**/*.{ts,tsx}`): the check's area. It applies only when the change touches a file in it (see [Targeted checks](#targeted-checks)). Without `paths`, a check with a `cwd` covers that folder, and one with neither covers the whole repository: it applies to any change. `**` crosses directories, `*` and `?` do not, `{a,b}` is either; a glob without a slash matches a file name anywhere, and one ending in `/` everything under it. A `!glob` takes files back out: `["src/**", "!src/gen/**"]`. |
| `cwd` | The folder it runs in, inside the repository: a package of a monorepo (`"packages/api"`). Default the repository root. Without `paths`, it is also the check's area. While the folder does not exist the check fails, saying so, rather than run somewhere it would check nothing. |
| `env` | Variables set for it, up to 20: `{ "NODE_ENV": "test" }`. The brief shows the command with both, as one line the harness can run from the root. |
| `optional` | `true`: a failure is reported, and the brief says it is not part of done. |

A stage holds at most 20 checks.

`coplan check` runs each check in a process group of its own. When it exits,
anything it started that is still running in that group (a stray test
worker, a server started with `&`) is stopped, so nothing outlives the check
it belongs to. A server meant for the checks after it needs a group of its
own: `setsid npm run dev &` (on macOS, which has no `setsid`, run the server
and the checks that use it as one check).

**One task's checks.** A task can skip some of these checks, or add checks of
its own — a docs-only task skipping the test suite, a migration adding
`pnpm db:check`. Only the user sets them, in the task's details in Coplan
(the agent proposes them, `set_checks`); subtasks inherit them. They show in
the task's brief, on the board, and under the build report.

Coplan never runs these itself. They reach the harness in the handoff and in
each task's brief (`harness_task_brief`), and the harness runs them like any
other command, under your permission settings. A harness can use
`coplan check <stage>`, which runs a stage's checks for what changed and
prints only the tail of what failed: `--since <commit>` measures the change
from where a task began, `--files a,b` names the files instead of git,
`--all` runs every check whatever changed, `--list` prints them without
running, and `--json` prints results in the shape `harness_task_update`
takes.

### `hooks`

The name of [`checks`](#checks) before 0.4. Read as an alias for one
release; `checks` wins where both are set.

### Targeted checks

Every check applies only to what changed, so a change pays only for the
checks of the areas it touched:

- **A task's change** is everything since the commit it began at —
  committed since, staged, unstaged and new. Not the files the task planned
  to touch: a planned file it never edited calls for no check, and one it
  edited outside the plan gets its check.
- **The build's change**, for `final`, is everything since the base branch.
- **A check applies only when its area changed**: its `paths`, else the
  folder in its `cwd`, else the whole repository (any change). When nothing
  changed, nothing runs.
- `{files}` in a command narrows the tool itself to the changed files.

Where git cannot read the change (it fails or times out), the change is
more than 5,000 files, or no base branch is found to measure the build
from, every check applies, and `coplan check` says why: a change nobody
could read is never taken for one that touched nothing.

A file that cannot be read, a stage that does not exist, a check without a
command, a key Coplan does not read (often a typo of one it does), a value
out of range: each is reported — in the prompts, the sign-off dialogs,
`coplan check` and `coplan doctor` — rather than silently skipped or
clamped. Each says what is used instead: a number past its limit is cut to
the limit, and anything else that cannot be used falls back to its default.

`coplan check` refuses to run only when the checks themselves cannot be
trusted: the file cannot be read, `checks` is wrong, or a top-level key is
unknown (often a misspelt `checks`). Anything else — a template that is
missing, a problem in your own `coplan.json` — is said, and the checks run.

### `review`

The review a task asks the harness for, passed on in its brief: `agent` (an
agent that did not write the change reviews it, where the harness has one),
`user` (the harness stops and asks you), or `none` (the checks are the
review). Default `agent`. Set it for the repository, in your own
`coplan.json`, or on one task in Coplan (subtasks inherit it). How the
review runs, and how many rounds, is the harness's call; Coplan does not
run or gate review rounds. The old values read as: `subagent` and `self` →
`agent`, `skip` → `none`; for one release `iric.review` is read as
`review` when `review` is not set to one of these (missing, or the old
object form below), with a warning. An `iric.review` it cannot read is an
error, the same as a bad `review`, and `agent` is used.

Before 0.4, `review` was an object: `review.model`, the model a reviewer
subagent ran on. That form is ignored from 0.4, with a warning: models and
accounts belong to the harness.

### `mode`

Deprecated, ignored from 0.4. It chose `export`, `tracked` or `managed`;
now there is one way: submitting locks the plan and produces the handoff.
**Export plan**, in the header, still copies the plan as Markdown at any
point.

### `iric`

Deprecated, ignored from 0.4. `iric.review` is now
[`review`](#review), read as it for one release; `iric.parallel` and `iric.maxRounds` are
gone — parallelism and review rounds belong to the harness. `coplan doctor`
says which: that `iric.review` is read as `review` and the rest is not, or,
where `review` is already set, that none of `iric` is read. `coplan setup`
replaces an old `iric` in your own `coplan.json` with `review`.

### `branches`

| Key | Meaning |
| --- | --- |
| `base` | The branch work is cut from and merged back into. Named in the prompts and briefs. |
| `prefix` | Suggested to Claude for the branches it names when a plan lands as several pull requests. |

### `pullRequests`

| Key | Default | Meaning |
| --- | --- | --- |
| `template` | — | A file in the repository (`.github/pull_request_template.md`), passed to the harness as a path in the handoff so it writes each description from it. Up to 8,000 characters. Coplan writes no pull request bodies. |

Deprecated, ignored from 0.4 — opening and following pull requests belongs
to the harness:

| Key | Deprecated |
| --- | --- |
| `tool` | Was `gh`, `graphite` or `none`. The harness opens pull requests its own way. |
| `open` | Was `auto`, `ask` or `never`. The harness decides when. |
| `watch` | Removed: pull request watching and CI follow-up belong to the harness. Ignored, with a `coplan doctor` warning. |
| `on` | Removed with `watch`. Ignored, with a `coplan doctor` warning. |

### `final`

Deprecated, ignored from 0.4. `final.blocking` refused the build report
while a final check failed; now the report is never refused, and shows the
final checks the harness reported.

### `instructions`

Your words, added to what the agent is told at one point. Each is text, or
`{ "file": "docs/agents/handoff.md" }` (a file in the repository), up to
4,000 characters:

| Point | Where it goes |
| --- | --- |
| `design` | The prompt that asks for the task list, once the design is confirmed. |
| `handoff` | The handoff prompt, under *Standing instructions*. |
| `brief` | Every task's brief (`harness_task_brief`), which the harness hands to whoever builds the task. |

`build` and `review` are deprecated, ignored from 0.4: `build` is now
`handoff`, and what a reviewer checks goes into `brief`, which lands in each
brief's acceptance section.

Your own (`coplan.json`, or `instructions/<point>.md` in Coplan's home)
come first, then the repository's.

### `planCheck`

How each rule of the plan check (`harness_plan_check`, and the gaps the
sign-off dialogs list) counts here: `error` holds *Confirm design* and
*Submit* until it is fixed, `warn` (the default) lists it, `off` does not
show it. The canvas follows `box-unbuilt` too: a box no task builds says *no
task* on it unless the rule is `off`.

```jsonc
"planCheck": { "box-undescribed": "error", "comment-unanswered": "error", "task-builds-nothing": "off" }
```

The rules: `box-unbuilt` (no task builds a box), `task-builds-nothing`,
`box-undescribed`, `task-undetailed` (once the task list is made),
`node-id-shared` (one box id in two diagrams), `branch-two-bases` (a branch
a stack of pull requests cannot follow), `comment-unanswered`.

### `runners`

Removed in 0.4: where and how tasks run belongs to the harness. Ignored,
with a `coplan doctor` warning.

## Your own defaults: `coplan.json`

`~/.claude/cc-harness/coplan.json` sets your defaults for every repository:
any key above except `checks`, which belong to each repository. A
repository's `.coplan/config.json` overrides it key by key — its `branches`
win over yours, and your `review` still holds if it does not say — and
instructions add up, yours first. Files it names are
read from Coplan's home.

```jsonc
{
  "review": "agent",
  "pullRequests": { "template": ".github/pull_request_template.md" },
  "instructions": { "handoff": "Small commits, each with a message that says why." }
}
```
