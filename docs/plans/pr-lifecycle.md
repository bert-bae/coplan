# Epic: PR lifecycle — from plan to merged

Status: proposed · Branch prefix: `coplan/pr-`

## Goal

Today a Coplan build ends at the build report: tasks go through
implement → review → refine (iric), branches are pushed, pull requests are
opened, and the agent *records* each PR with `harness_branch_update`. After
that nobody is listening. CI fails, a reviewer asks for changes, a lower PR in
the stack merges — and the plan just says "built".

This epic makes the loop end-to-end, and optional at every step:

```
plan → tasks → iric (implement → review → refine) → push → PR
   ↑                                                      │
   └──── fix task ← dispatch (configured hooks) ← PR event ┘   … until merged
```

Coplan subscribes to every PR it recorded for a plan, turns what happens on
it (comment, review, failed CI, conflict, merge) into events, and runs the
repository's configured hooks for each: open a fix task that goes back through
iric, rebase, notify, run a command, or ignore. The plan is done when its PRs
are merged (or closed), not when the report is written.

## What already exists (reuse, don't rebuild)

| Piece | Where | Used for |
| --- | --- | --- |
| `plan.branches[b].pr {url, number, state}`, `base` | `src/shared/types.ts` `BranchState` | **The subscription list.** A PR recorded open/draft is watched; nothing new to register. |
| `harness_branch_update` | `src/mcp/tools.ts`, `src/daemon/main.ts` (~1840) | Agent records PR open/merged/closed and restacks. |
| Restack after a lower PR merges | `src/shared/build.ts` (~442–470) | The `merged` action reuses it as-is. |
| `pullRequests.{tool, open, template}` | `docs/CONFIG.md`, `src/shared/config.ts` | Extended with `watch` and `on`. |
| Hook shape `{name, run, timeout, env, optional}` | `.coplan/config.json` `hooks` | Same shape for PR `run` actions. |
| Queued prompt delivered on the next `UserPromptSubmit` | `store.pending()`, `hookIngest.ts` | Fallback delivery of PR events. |
| `addedInBuild`, `reopened`, `round`, `reviews` on tasks | `Task` | Fix tasks are ordinary build tasks. |
| `isIdle` | `src/daemon/idle.ts` | Must count watched PRs as a reason to stay up. |

## Design

### 1. Where events come from (depends on where the PR lives)

One small provider interface, picked from `pullRequests.tool` and the
remote's host:

```ts
interface PrProvider {
  // Everything new on this PR since `cursor`; cheap when nothing changed.
  poll(pr: WatchedPr, cursor: PrCursor): Promise<{ events: PrEvent[]; cursor: PrCursor }>;
}
```

| Where | Source | Notes |
| --- | --- | --- |
| GitHub (`gh`, `graphite`) | **Daemon polls** with `gh api` (PR, check-runs for head SHA, reviews, review comments, issue comments) using ETags, so an unchanged PR costs a 304. | Default. Uses the user's own `gh` auth; nothing new to configure. |
| Cloud sessions (Claude Code on the web) | **Agent-reported**: the session already has `subscribe_pr_activity`; the build prompt tells it to subscribe and forward each event with `harness_pr_event`. | No daemon polling there (no `gh` auth in the container). |
| GitLab / Bitbucket | Interface only in v1. | `glab api` provider later. |
| `tool: none` | Not watched. | |

Webhook receiving (a public URL, HMAC secrets) is deliberately **not** in v1;
polling every 60s is good enough for a human-paced review loop.

### 2. Events

Normalized and de-duplicated per PR (cursor = seen ids + last head SHA +
last check conclusions + last mergeable state):

`ci_failed`, `ci_passed`, `changes_requested`, `approved`, `review_comment`
(inline), `comment` (conversation), `merge_conflict`, `behind_base`,
`merged`, `closed`, `reopened`.

Bursts are batched: events on one PR within `debounce` seconds (default 90)
become one dispatch, so a 12-comment review is one fix pass, not twelve.

### 3. Configured hooks — `.coplan/config.json`

```jsonc
"pullRequests": {
  "tool": "gh",
  "open": "auto",
  "watch": {
    "enabled": true,          // off: PRs are recorded, never watched (today's behaviour)
    "interval": 60,           // seconds, min 30
    "debounce": 90,
    "trust": "collaborators", // whose comments may start work: "collaborators" | "author" | ["login", …]
    "maxFixRounds": 3,        // per PR; past it, the user decides
    "wake": "wait"            // how the agent is reached: "wait" | "queue" | "headless"
  },
  "on": {
    "ci_failed": "fix",
    "changes_requested": "fix",
    "review_comment": "fix",
    "comment": "triage",
    "merge_conflict": "rebase",
    "behind_base": "ignore",
    "approved": ["notify", { "name": "automerge", "run": "gh pr merge {pr} --auto --squash", "optional": true }],
    "merged": "advance",
    "closed": "notify"
  }
}
```

Actions (one or a list, run in order):

| Action | What happens |
| --- | --- |
| `fix` | A fix task is added under the branch (`addedInBuild`, `source: {pr, events}`), with the failing check's log tail / the comments as its brief. It runs the normal iric cycle, then pushes, replies on each thread it answered, and records the round. |
| `triage` | The agent reads it and decides: reply, open a fix task, or nothing — and says which on the board. |
| `rebase` | Rebase the branch onto its base, rerun `implement` checks, push. Conflicts it can't resolve become a fix task. |
| `advance` | Record merged; restack the branches above it (existing `build.ts` logic); when every PR is merged/closed the plan is `built`. |
| `notify` | Toast on the board + the session's "answer in…" link. No agent work. |
| `ignore` | Logged on the PR's timeline only. |
| `{ run, name, timeout, env, optional }` | A command, same shape as `hooks`; `{pr}`, `{branch}`, `{event}`, `{sha}` substituted. **Run by the agent** under its permission settings — Coplan keeps its rule of never running commands itself. |

Defaults when `on` is absent: the table above minus the `automerge` entry.
Coplan never merges unless a `run` action says so.

### 4. Reaching an idle agent (`watch.wake`)

The hard part: events arrive when the agent's turn has ended.

| Mode | How | Where it works |
| --- | --- | --- |
| `wait` (default for Claude Code) | After opening PRs the agent starts `coplan pr wait` as a **background command**. It long-polls the daemon and exits with the batched event prompt when there is work; exiting re-invokes the agent, which handles it and re-arms the wait. | Claude Code local / Remote Control. |
| `queue` (default elsewhere) | The prompt is queued like a revision request and rides on the user's next message; the board and the desktop link say work is waiting. | Every agent (Codex, Cursor). |
| `headless` (opt-in) | The daemon runs `claude -p --resume <session>` / `codex exec resume` with the prompt. | Machines that should run unattended. |
| (cloud) | Native `subscribe_pr_activity` wakes the session; it forwards with `harness_pr_event`. | Claude Code on the web. |

### 5. The plan's life

New phase **`landing`** between `finalizing` and `built`: report written, PRs
still open and watched. Status mapping: `landing` → `review`. `built` now means
every watched PR is merged or closed (or watching is off — today's behaviour).

Board: each branch row shows PR state, CI, review state, unresolved threads,
fix rounds used, and a timeline of events and the action each got.

### 6. Guardrails

- PR text is untrusted input. Comments from outside `watch.trust` are shown,
  never acted on. Event text reaches the agent inside a marked untrusted block.
- `maxFixRounds` per PR, then `notify` and stop acting on that PR.
- Never force-push a branch Coplan didn't create; never skip or disable a
  test to turn CI green (stated in the fix prompt, as iric already does).
- Watching stops on merged/closed, on `watch.enabled: false`, on
  `coplan pr unwatch`, or when the session is pruned (30 days).
- The daemon stays up while it watches open PRs (`isIdle`), but polling backs
  off to 5 min after 24h without activity.

## Task list

Four stacked branches. Each task goes through iric with the repository's
existing checks (`pnpm run typecheck`, tests).

### Branch `coplan/pr-1-model` (base: `main`)

**T1 — Config and types.** `pullRequests.watch` / `pullRequests.on` in
`src/shared/config.ts` with validation (unknown keys/out-of-range reported
like the rest), `PrEvent`, `PrCursor`, `PrAction` types, `Task.source`,
`BranchState.watch {cursor, fixRounds, lastEventAt, checks, review}`.
Docs in `docs/CONFIG.md`.
*Done when:* config tests cover defaults, a full block, and each bad value.

**T2 — Event normalization and dedup** (depends T1). Pure function: raw
GitHub API responses + cursor → events + new cursor; debounce batching.
*Done when:* fixture tests (`src/test/golden`) for each event kind, a replayed
poll yields nothing, a 12-comment review yields one batch.

### Branch `coplan/pr-2-watch` (stacks on pr-1)

**T3 — GitHub provider** (depends T2). `gh api` calls with ETag caching,
rate-limit aware; failing-check log tail via `gh run view --log-failed`
(truncated). Provider picked from `pullRequests.tool` + remote host.
*Done when:* tested against a fake `gh` on `PATH`; no `gh` / not authed is
reported by `coplan doctor`, not crashed on.

**T4 — Watcher loop in the daemon** (depends T3). Watches every
`branches[*].pr` in state open/draft for sessions with watching on; persists
cursors in `state.json`; stop conditions; `isIdle` counts watched PRs;
backoff.
*Done when:* integration test: recording a PR starts watching, recording
merged stops it, a restart resumes from the stored cursor.

### Branch `coplan/pr-3-dispatch` (stacks on pr-2)

**T5 — Dispatcher** (depends T4). Event batch → actions per `on`; trust
filter; `fix` creates the fix task; `advance` reuses the restack; round limit;
every decision written to the PR timeline.
*Done when:* table-driven tests for each action, the trust filter, and the
round limit.

**T6 — Delivery** (depends T5). Daemon endpoint the CLI long-polls;
`coplan pr wait|status|unwatch`; `queue` reuses the pending-prompt path in
`hookIngest.ts`; the prompt text (untrusted block, what to do per action).
*Done when:* `coplan pr wait` exits with the prompt when a batch is
dispatched, and exits cleanly on unwatch / daemon stop.

**T7 — MCP tools** (depends T5). `harness_pr_event` (agent-reported events
for cloud sessions, same dispatcher), `harness_pr_events` (read/ack the
timeline); `harness_task_next` returns PR work in `landing`;
`harness_branch_update` gains `fix_round` reporting. Update
`src/test/contract.test.ts`.
*Done when:* MCP tests cover both tools and the `landing` guidance.

### Branch `coplan/pr-4-land` (stacks on pr-3)

**T8 — `landing` phase and board** (depends T7). `planPhase` /
`PLAN_STATUSES` mapping, render prompts, branch rows with PR/CI/review state
and the event timeline in the Tasks view.
*Done when:* status and UI tests; golden prompts updated.

**T9 — Skills and docs** (depends T7). `skills/coplan-build`: a *Landing*
section after the report (arm `coplan pr wait`, handle a batch, re-arm; cloud:
`subscribe_pr_activity` + `harness_pr_event`). `skills/iric`: fix tasks
from PR events (reply on threads, push, never skip tests). `docs/GUIDE.md`
walkthrough.

**T10 — End-to-end test** (depends T8). Fake `gh` scripted through:
PR opened → `ci_failed` → fix task through iric → `ci_passed` →
`changes_requested` → fix → `approved` → lower PR `merged` → restack →
upper `merged` → plan `built`.

**T11 — `headless` wake** (depends T6; optional, last). Daemon spawns the
agent's resume command with the prompt; one at a time per session; off unless
configured.

## Out of scope (v1)

Webhook receiver, GitLab/Bitbucket providers, auto-merge by default,
watching PRs Coplan didn't record.

## Open questions

1. Default `wake` for Claude Code: `wait` (background command) or `queue`
   (needs the user to type)? Proposed: `wait`.
2. Should `run` actions ever run in the daemon when no agent is reachable
   (e.g. an automerge command), or always through the agent? Proposed: always
   the agent.
3. Is `headless` (T11) wanted at all, given it runs an agent unattended?
