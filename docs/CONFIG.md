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
| `sessions/<id>/state.json` | One session's plan, change log, comments and — once submitted — the prompt it was submitted with. Kept 30 days after its last change. |
| `config.json` | Your global configuration. |
