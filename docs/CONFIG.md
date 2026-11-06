# Configuration

Three layers, merged in order:

1. the defaults in the table below
2. user global — `~/.claude/cc-harness/config.json`
3. project — `<repo>/.claude/harness.json`

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
in Claude) writes a starting point from the repository's scripts.

```jsonc
{
  "hooks": {
    "implement": ["pnpm typecheck", { "name": "ruff", "run": "ruff check .", "paths": ["*.py"] }],
    "review": [{ "name": "tests", "run": "pnpm test", "timeout": 900 }],
    "final": ["pnpm check", { "name": "audit", "run": "pnpm audit", "optional": true }]
  },
  "iric": { "review": "subagent", "parallel": 2, "maxRounds": 3 },
  "branches": { "base": "main", "prefix": "coplan/" }
}
```

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
| `run` | The shell command. Required. |
| `name` | What it is called in reports and on the board, up to 60 characters. Defaults to the script name (`pnpm lint` or `npm run lint` → `lint`). |
| `timeout` | Seconds before `coplan check` stops it: 1 to 3600. Default 600. |
| `paths` | Globs (`src/**`, `*.py`, `docs/`, `src/**/*.{ts,tsx}`): the hook applies only to tasks that expect to touch a matching file. A task that lists no files gets every hook. `**` crosses directories, `*` and `?` do not, `{a,b}` is either; a glob without a slash matches a file name anywhere, and one ending in `/` everything under it. A `!glob` takes files back out: `["src/**", "!src/gen/**"]`. |
| `cwd` | The folder it runs in, inside the repository: a package of a monorepo (`"packages/api"`). Default the repository root. |
| `env` | Variables set for it, up to 20: `{ "NODE_ENV": "test" }`. The prompts show the command with both, as one line the agent can run from the root. |
| `optional` | `true`: a failure is reported but does not hold the task back. |

A stage holds at most 20 hooks.

Coplan never runs these itself. They reach Claude in the build prompt and in
each task's brief (`harness_task_brief`), and Claude runs them like any
other command, under your permission settings. `coplan check <stage>` runs a
whole stage at once and prints only the tail of what failed; `--files a,b`
keeps to the hooks for those files, `--list` prints them without running,
and `--json` prints results in the shape `harness_task_update` takes.

Claude reports the checks it ran with each task. A task whose last reported
checks include a failure (not `optional`) cannot be marked done.

A file that cannot be read, a stage that does not exist, a hook without a
command, a key Coplan does not read (often a typo of one it does), a value
out of range: each is reported — in the prompts, the review dialogs, `coplan
check` and `coplan doctor` — rather than silently skipped or clamped. Each
says what is used instead: a number past its limit is cut to the limit, and
anything else that cannot be used falls back to its default.

### `iric`

The build's defaults, which the submit dialog starts from and the user can
change for each plan:

| Key | Default | Meaning |
| --- | --- | --- |
| `review` | `subagent` | Who reviews a task that does not say otherwise: `subagent` (a fresh agent that did not write the change), `self`, `user` (Claude stops and asks you), or `skip` (the review checks only). |
| `parallel` | `2` | How many ready tasks are built at once, each by its own subagent. 1 to 8. |
| `maxRounds` | `3` | Review rounds a task may take before Claude stops and asks you. 1 to 10. |

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
| `open` | `ask` | `auto`: as soon as a branch's tasks are done. `ask`: once you say to. `never`: no pull requests; the branches are pushed and listed in the report. |
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
show it.

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
