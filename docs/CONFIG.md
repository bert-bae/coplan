# Configuration

Three layers, merged in order:

1. the defaults in the table below
2. user global — `~/.claude/cc-harness/config.json`
3. project — `<repo>/.claude/harness.json`

`./setup.sh` can set the main ones for you — answer yes to *Adjust settings
now?* — along with [your build defaults](#your-own-defaults-coplanjson) and a
[repository's checks](#the-repository-coplanconfigjson). Everything else is
set here, by hand.

Later layers override earlier ones key by key, except `idleShutdownMinutes`,
which only the global file sets: one daemon serves every repository. An edit
to either file counts at once, with no restart.

Both files are JSON with comments: `//` to the end of a line and `/* … */`
anywhere outside a string, and a trailing comma is allowed. Nothing is
skipped silently: a file that is not valid JSON, a key Coplan does not read,
or a value of the wrong type or out of range is written to `daemon.log` and
reported by `coplan doctor`, and the value from the layer before is used.
The keys the old review loop used (`gateHoldSeconds`, `stages`, `ship`) are
still ignored without a word, so an old config file does no harm.

| Key | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `false` | Open the plan in a browser the first time Claude publishes one in a session. Off by default: the plugin is installed globally, and a tool should not open windows you did not ask for. Use `/coplan-open`, `coplan open`, or the URL the tools print. |
| `promptNotice` | `true` | When you type in Claude's chat after changing the plan in the browser, add one line to the prompt telling Claude to call `harness_plan_read`. Turn it off if you would rather always say so yourself. It does not affect the build prompt: submitting a plan for this session is itself the request to send it. |
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
| `sessions/<id>/state.json` | One session's plan, change log, comments and — once signed off — the prompts it was confirmed and submitted with, and the build settings. Kept 30 days after its last change. |
| `config.json` | Your global configuration. |
| `coplan.json` | Your own defaults for every repository's build: the keys of `.coplan/config.json` below, except `hooks`. See [Your own defaults](#your-own-defaults-coplanjson). |
| `instructions/<point>.md` | Your own standing instructions, for `design`, `build`, `brief` or `review`: the same as `instructions` in `coplan.json`. |

## The repository: `.coplan/config.json`

The settings above are about Coplan on your machine. What a *build* runs
belongs to the repository, so it lives with the code — committed, so every
build there runs the same checks: `<repo>/.coplan/config.json`. Comments
and trailing commas are allowed, as above. `coplan init` (or `/coplan-init`
in Claude) writes a starting point from the repository's scripts, and so does
`./setup.sh` when you give it the repository's path.

```jsonc
{
  "mode": "managed",
  "hooks": {
    "implement": ["pnpm run typecheck", { "name": "ruff", "run": "ruff check .", "paths": ["*.py"] }],
    "review": [{ "name": "tests", "run": "pnpm run test", "timeout": 900 }],
    "final": ["pnpm run check", { "name": "audit", "run": "pnpm audit", "optional": true }]
  },
  "iric": { "review": "subagent", "parallel": 2, "maxRounds": 3 },
  "branches": { "base": "main", "prefix": "coplan/" }
}
```

### `mode`

How much of the build harness a plan takes by default. *Submit* starts from
it, and you can choose another mode for each plan there:

| Mode | What the agent is told | The board | What the daemon holds back |
| --- | --- | --- | --- |
| `export` | Nothing: you copy the plan out as Markdown, to build anywhere. Submitting locks a snapshot | Not followed | Nothing |
| `tracked` | Build it your own way, and report each task | Follows each task | Nothing: what Managed would refuse comes back as a note in the reply |
| `managed` | Take each task through implement → review → refine, with the checks below | Follows each task and its cycle | Done before a task went to review, without a passing verdict, or while a check fails or was never reported; more tasks at once than `iric.parallel`; a review round past `iric.maxRounds`; dropping work you signed off. Each needs your go-ahead |

Without `mode`, a repository whose `.coplan/config.json` sets [`iric`](#iric)
is Managed, as setting it has always meant; any other repository is
Tracked. `mode` wins where both are set. Your own
[`coplan.json`](#your-own-defaults-coplanjson) can set `mode` for every
repository, and a repository's file overrides it; your own `iric` only sets
how a Managed build runs, not the mode.

**Export plan**, in the page's header, copies the whole plan as Markdown in
any phase without submitting anything: the summary, sections, diagrams, the
tasks with their briefs, the build order and the open comments — and no
build instructions, review modes, round limits or Coplan tool names.

### `hooks`

The checks for each step of a task's implement → review → refine cycle:

| Stage | When it runs |
| --- | --- |
| `implement` | After every implementation or refinement pass, before a task goes to review. Keep it fast: typecheck, lint, format. |
| `review` | The gate: a task is done only once these pass. The tests, and anything CI would fail on. |
| `final` | Once every task is done, before the build report: the full suite, the build, repository-wide checks. |

A hook is a command, run from the repository root, or an object:

| Key | Meaning |
| --- | --- |
| `run` | The shell command. Required. `{files}` in it is the changed files in the hook's area, each quoted (`ruff check {files}`, `eslint {files}`), so the tool looks at nothing else; from the hook's `cwd` when it has one. Where the change is not known, or runs past 1,000 files, it is `.`, the whole repository. |
| `name` | What it is called in reports and on the board, up to 60 characters. Defaults to the script name (`pnpm run lint` → `lint`). |
| `timeout` | Seconds before `coplan check` stops it: 1 to 3600. Default 600. |
| `paths` | Globs (`src/**`, `*.py`, `docs/`, `src/**/*.{ts,tsx}`): the hook's area. It runs only when the change touches a file in it (see [Targeted checks](#targeted-checks)). Without `paths`, a hook with a `cwd` checks that folder, and one with neither checks the whole repository: it runs on any change. `**` crosses directories, `*` and `?` do not, `{a,b}` is either; a glob without a slash matches a file name anywhere, and one ending in `/` everything under it. A `!glob` takes files back out: `["src/**", "!src/gen/**"]`. |
| `cwd` | The folder it runs in, inside the repository: a package of a monorepo (`"packages/api"`). Default the repository root. Without `paths`, it is also the hook's area: the hook runs only when something under it changes. While the folder does not exist the hook fails, saying so, rather than run somewhere it would check nothing. |
| `env` | Variables set for it, up to 20: `{ "NODE_ENV": "test" }`. The prompts show the command with both, as one line the agent can run from the root. |
| `optional` | `true`: a failure is reported but does not hold the task back. |

A stage holds at most 20 hooks.

**One task's checks.** A task can skip some of these checks, or add checks of
its own — a docs-only task skipping the test suite, a migration adding
`pnpm db:check`. Only the user sets them, in the task's details in Coplan
(the agent proposes them, `set_checks`); subtasks inherit them. A skipped
check is not run and `done` does not wait on it; an added one runs at the
stage it names and gates `done` like the repository's, unless `optional`.
They show in the task's brief, on the board, and under the build report.

Coplan never runs these itself. They reach Claude in the build prompt and in
each task's brief (`harness_task_brief`), and Claude runs them like any
other command, under your permission settings. `coplan check <stage>` runs a
stage's checks for what changed and prints only the tail of what failed:
`--since <commit>` measures the change from where a task began,
`--files a,b` names the files instead of git, `--all` runs every check
whatever changed, `--list` prints them without running, and `--json` prints
results in the shape `harness_task_update` takes.

### Targeted checks

Every check the build runs is targeted to what changed, so a change pays
only for the checks of the areas it touched:

- **A task's change** is everything since the commit it began at — Coplan
  reads it when the task starts, where the task is built (its own worktree,
  if its branch has one) — committed since, staged, unstaged and new. Not
  the files the task planned to touch: a planned file it never edited calls
  for no check, and one it edited outside the plan gets its check.
- **The build's change**, for `final`, is everything since the base branch.
- **A check runs only when its area changed**: its `paths`, else the folder
  in its `cwd`, else the whole repository (any change). When nothing changed,
  nothing runs.
- `{files}` in a command narrows the tool itself to the changed files.

Claude reports the checks it ran with each task. A task whose last reported
checks include a failure (not `optional`) cannot be marked done, and nor can
one that never reported a required `review` check for what it changed;
`harness_task_update` names the command that runs exactly those
(`coplan check review --since <commit>`). Where git cannot say what changed,
the checks for the files the task planned to touch are held instead.

A file that cannot be read, a stage that does not exist, a hook without a
command, a key Coplan does not read (often a typo of one it does), a value
out of range: each is reported — in the prompts, the review dialogs, `coplan
check` and `coplan doctor` — rather than silently skipped or clamped. Each
says what is used instead: a number past its limit is cut to the limit, and
anything else that cannot be used falls back to its default.

`coplan check` refuses to run only when the checks themselves cannot be
trusted: the file cannot be read, `hooks` is wrong, or a top-level key is
unknown (often a misspelt `hooks`). Anything else — a template that is
missing, a reviewer model misspelt, a problem in your own `coplan.json` — is
said, and the checks run.

### `iric`

How a Managed build runs, which the submit dialog starts from and the user
can change for each plan. Setting it in the repository's file makes builds
there Managed by default (see [`mode`](#mode)):

| Key | Default | Meaning |
| --- | --- | --- |
| `review` | `self` | Who reviews a task that does not say otherwise: `subagent` (a fresh agent that did not write the change, where the agent has subagents), `self`, `user` (Claude stops and asks you), or `skip` (the review checks only). |
| `parallel` | `1` | How many ready tasks are built at once — with subagents, where the agent has them. 1 to 8. |
| `maxRounds` | `3` | Review rounds a task may take; another past them is yours to allow. 1 to 10. |

The defaults assume nothing about the agent: it reviews its own change,
one task at a time. Set `review: "subagent"` or a higher `parallel` where
your agent and your machine make them worth it; `coplan init` writes the
defaults out for you to change.

### `branches`

| Key | Meaning |
| --- | --- |
| `base` | The branch work is cut from and merged back into. Named in the prompts and briefs. |
| `prefix` | Suggested to Claude for the branches it names when a plan lands as several pull requests. |

### `pullRequests`

How a build's pull requests are opened. The build prompt says so, and
`harness_task_next` says when each one is due.

| Key | Default | Meaning |
| --- | --- | --- |
| `tool` | `gh` | `gh` (`gh pr create`, each against the branch below it), `graphite` (`gt track` each branch, `gt submit --stack`), or `none` (the agent pushes the branches and you open the pull requests). |
| `open` | `ask` | `auto`: as soon as a branch's tasks are done. `ask`: once you say to — opening a pull request reaches outside the session, so by default Claude asks first. `never`: no pull requests; the branches are pushed and listed in the report. |
| `template` | — | A file in the repository (`.github/pull_request_template.md`) each description is written from, filled in from the tasks the pull request carries, their checks and their review. Up to 8,000 characters. |

### `review`

| Key | Meaning |
| --- | --- |
| `model` | The model the reviewer subagent runs on (`"opus"`, `"sonnet"`), when it should not be the agent's own. Only for `iric.review: "subagent"`. |

### `final`

| Key | Default | Meaning |
| --- | --- | --- |
| `blocking` | `false` | `true`: the build report is refused until it carries every final check that is not `optional`, passing, in its `checks`. The plan is not built while those fail. |

### `instructions`

Your words, added to what the agent is told at one point. Each is text, or
`{ "file": "docs/agents/build.md" }` (a file in the repository), up to
4,000 characters:

| Point | Where it goes |
| --- | --- |
| `design` | The prompt that asks for the task list, once the design is confirmed. |
| `build` | The build prompt, under *Standing instructions*. |
| `brief` | Every task's brief (`harness_task_brief`), which subagents are given. |
| `review` | Each brief's review step: what a reviewer checks here. |

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

## Your own defaults: `coplan.json`

`~/.claude/cc-harness/coplan.json` sets your defaults for every repository:
any key above except `hooks`, which belong to each repository. A
repository's `.coplan/config.json` overrides it key by key — its
`iric.parallel` wins over yours, and your `iric.review` still holds if it
does not say — and instructions add up, yours first. Files it names are
read from Coplan's home.

```jsonc
{
  "iric": { "review": "self" },
  "pullRequests": { "tool": "graphite", "open": "auto" },
  "instructions": { "build": "Small commits, each with a message that says why." }
}
```
