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
| `autoOpen` | `false` | Open the plan in a browser the first time Claude publishes one in a session. Off by default: the plugin is installed globally, and a tool should not open windows you did not ask for. Use `/harness-open`, `harness open`, or the URL the tools print. |
| `promptNotice` | `true` | When you type in Claude's chat after changing the plan in the browser, add one line to the prompt telling Claude to call `harness_plan_read`. Turn it off if you would rather always say so yourself. |
| `idleShutdownMinutes` | `120` | Exit after this long with no active session and no browser attached. The next hook starts a fresh daemon. `0` disables it. |

## Files

Everything lives under `~/.claude/cc-harness` (override with
`CC_HARNESS_HOME`):

| Path | What it is |
| --- | --- |
| `daemon.json` | The running daemon's address and token. |
| `daemon.log` | The daemon's log; trimmed by `harness clean`. |
| `sessions/<id>/state.json` | One session's plan, change log and comments. Kept 30 days after its last change. |
| `config.json` | Your global configuration. |
