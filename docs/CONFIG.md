# Configuration

Three layers, merged in order:

1. shipped defaults — [`config/defaults.json`](../config/defaults.json)
2. user global — `~/.claude/cc-harness/config.json`
3. project — `<repo>/.claude/harness.json`

Later layers override earlier ones key by key. Unknown keys — including the
ones the old review loop used (`gateHoldSeconds`, `stages`, `ship`, …) — are
ignored, so an old config file does no harm.

| Key | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `false` | Open the plan in a browser the first time Claude publishes one in a session. Off by default: the plugin is installed globally, and a tool should not open windows you did not ask for. Use `/coplan-open`, `coplan open`, or the URL the tools print. |
| `promptNotice` | `true` | When you type in Claude's chat after changing the plan in the browser, add one line to the prompt telling Claude to call `harness_plan_read`. Turn it off if you would rather always say so yourself. It does not affect the build prompt: submitting a plan for this session is itself the request to send it. |
| `openClaudeOnQuestion` | `false` | When the agent asks you something (`AskUserQuestion` or `request_user_input`, or a permission prompt), open that session in its desktop app straight away instead of waiting for you to click *Answer in …*. Works for a local Claude Code session with Remote Control on and for a Codex thread (in the Codex app): those are the only local sessions with a documented link, and a cloud session's daemon has no screen to open anything on. Cursor has no link to a chat, so it is never opened. |
| `idleShutdownMinutes` | `120` | Exit after this long with no active session and no browser attached. The next hook starts a fresh daemon. `0` disables it. |

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

## The repository: `.coplan/config.json`

The settings above are about Coplan on your machine. What a *build* runs
belongs to the repository, so it lives with the code — committed, so every
build there runs the same checks: `<repo>/.coplan/config.json`. Line
comments (`//`) are allowed. `coplan init` (or `/coplan-init` in Claude)
writes a starting point from the repository's scripts.

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
| `name` | What it is called in reports and on the board. Defaults to the script name (`pnpm lint` or `npm run lint` → `lint`). |
| `timeout` | Seconds before `coplan check` stops it. Default 600. |
| `paths` | Globs (`src/**`, `*.py`, `docs/`): the hook applies only to tasks that expect to touch a matching file. A task that lists no files gets every hook. |
| `optional` | A failure is reported but does not hold the task back. |

Coplan never runs these itself. They reach Claude in the build prompt and in
each task's brief (`harness_task_brief`), and Claude runs them like any
other command, under your permission settings. `coplan check <stage>` runs a
whole stage at once and prints only the tail of what failed; `--files a,b`
keeps to the hooks for those files, `--list` prints them without running,
and `--json` prints results in the shape `harness_task_update` takes.

Claude reports the checks it ran with each task. A task whose last reported
checks include a failure (not `optional`) cannot be marked done.

A file that cannot be read, a stage that does not exist, a hook without a
command: each is reported — in the prompts, the review dialogs and `coplan
check` — rather than silently skipped.

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
