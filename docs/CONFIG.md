# Configuration

Three layers, merged in order:

1. shipped defaults — [`config/defaults.json`](../config/defaults.json)
2. user global — `~/.claude/cc-harness/config.json`
3. project — `<repo>/.claude/harness.json`

Later layers override earlier ones key by key. `stages` merges per stage and
`ship.providers` merges per provider, so a project can add one check or one
provider without restating everything else.

## Top level

| Key | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `false` | Open a browser window the first time a session engages the harness. Off by default: the plugin is installed globally, and a tool should not open windows you did not ask for. Use `harness open`, or the URL the tools print. |
| `maxTimelineEvents` | `500` | Ring-buffer size for the session feed. |
| `stopHoldSeconds` | `540` | How long one `Stop` hook holds a finished turn open while a gate is unresolved. Must stay below the hook's own `timeout` in `hooks/hooks.json` (600s). |
| `awaitSeconds` | `120` | How long one `harness_await` call parks before returning `pending`. `harness_await` is the escape hatch, not the loop — waiting normally happens in the `Stop` hook. |
| `gateHoldRounds` | `4` | How many `Stop` windows in a row the harness re-parks on the same gate before letting the session go idle. Total patience is `gateHoldRounds × stopHoldSeconds` (36 minutes by default); `0` holds indefinitely. Each rollover costs one short turn, because a turn is the only thing that can re-arm the hook. |
| `holdIdleSessions` | `false` | Hold a finished turn open even with no gate, so a message typed in the browser reaches a session that would otherwise go idle. Costs an occupied terminal and draws on the CLI's consecutive-`Stop`-block allowance — turn it on for a session you intend to drive entirely from the browser. |
| `maxDiffFileBytes` | `400000` | Files whose rendered diff exceeds this are shown as a stub. |
| `idleShutdownMinutes` | `120` | Exit after this long with no live session, no open gate and no browser attached. The next hook starts a fresh daemon. `0` disables it. |

## `stages`

Each of `planning`, `plan_review`, `implementing`, `code_review`,
`verification`, `ship` accepts:

Whether a stage opens a gate is decided by the tool that enters it, not by
config: publishing a plan, a diff, a check run or a ship always opens one.

| Key | What it does |
| --- | --- |
| `instructions` | Path to a markdown file, relative to the config directory or the repo root. Its contents are returned to Claude when the stage is entered — and only then, so it costs tokens once. |
| `checks` | `verification` only: the commands to run. |

Example — a repo with real checks and a house style for reviews:

```json
{
  "stages": {
    "verification": {
      "checks": ["pnpm typecheck", "pnpm lint", "pnpm test -- --run"]
    },
    "code_review": {
      "instructions": ".claude/review-guidelines.md"
    }
  }
}
```

## `ship`

| Key | What it does |
| --- | --- |
| `steps` | Which steps the ship stage offers, in order: `checks`, `commit`, `push`, `pr`, `summary`. The user's confirmed selection in the UI is what actually runs. |
| `provider` | The default provider id. |
| `providers` | Map of id → provider. |
| `summaryPath` | Where the review summary is written. Supports `{{branch}}` and `{{date}}`. |
| `commitTemplate` | Supports `{{title}}` and `{{body}}`. |

### Providers

**`kind: "command"`** runs in the daemon. Placeholders: `{{title}}` (already
shell-quoted), `{{body}}`, `{{bodyFile}}`, `{{branch}}`, `{{base}}`.

```json
{
  "kind": "command",
  "label": "GitHub (gh CLI)",
  "command": "gh pr create --base {{base}} --head {{branch}} --title {{title}} --body-file {{bodyFile}}"
}
```

**`kind: "mcp"`** cannot run in the daemon — MCP servers are connected to the
Claude session, not to the harness. The directive is handed back to Claude
along with the composed title and body, and Claude makes the call.

```json
{
  "kind": "mcp",
  "label": "Bitbucket",
  "directive": "Open a pull request using the connected Bitbucket MCP server. Title and body below, source branch {{branch}}, destination {{base}}. Report the PR URL with harness_note."
}
```

**`kind: "none"`** skips the PR step entirely.

Any number of providers can coexist; the UI shows them in a dropdown at the
ship gate.

## Keyboard

In the review: `j`/`k` (or `]`/`[`) move between files, `v` marks the current
file viewed, `p` toggles the pending-comments panel, `r` recomputes the diff,
`/` focuses the file filter. `1`–`6` switch tabs anywhere.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CC_HARNESS_HOME` | Move all state off `~/.claude/cc-harness` (used by tests). |
| `CC_HARNESS_PORT` | Pin the daemon's port instead of using an ephemeral one. |
| `CC_HARNESS_DEBUG` | Mirror the daemon log to stderr. |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | Claude Code's own cap on consecutive `Stop` blocks (default 8). The harness long-polls inside a single hook invocation rather than blocking repeatedly, so this rarely matters. |
