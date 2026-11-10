# Clean-up, refactor and test loop

A backlog from the `/ponytail-audit` run of 2026-11-10 (the full report is at
the end), and the loop that works through it, one row per turn. The ledger is
the loop's memory: a turn reads it, does one open row, ticks it, and commits.

Baseline when this was written: `pnpm typecheck` clean, `pnpm test` 682 pass,
1 skipped (store.test.ts:214 skips when run as root; CI runs it).

## Order

1. **Safety net first.** Tests for risky code that later rows change, so a
   refactor that breaks it fails a test instead of a user.
2. **Fix** the Must-fix rows, then the Should-fix rows. Every fix starts with
   a test that reproduces the audit's case and fails.
3. **Clean up:** delete what is dead.
4. **Refactor:** merge the copies, now pinned by the tests from step 1.
5. **Smaller rows**, then **re-audit** the touched areas. New findings become
   new rows. The loop ends when a re-audit finds only Nice-to-have or nothing.

Tests come before the clean-up and refactor rows on purpose: a refactor with
no test that fails when it breaks is the risk the audit itself flags.

## One turn of the loop

1. **Pick** the first `open` row in the ledger, top to bottom. Skip `blocked`
   and `needs-decision` rows.
2. **Pin.** For a fix: write the test from the finding's case and see it fail.
   For a clean-up or refactor: find the test that covers the code, or write one
   that passes now. No test, no refactor.
3. **Change** the smallest thing the finding names. Something new you notice
   goes in the ledger as a new row, not into this commit.
4. **Check** with the repo's own runner, which targets what changed:
   `./bin/coplan check implement` (typecheck), then `./bin/coplan check review`
   (build and test). At the end of a phase: `./bin/coplan check final`
   (`pnpm check` and the doctor).
5. **Review** the diff with `/code-review medium` and fix what it confirms.
   For refactor rows, also run `/simplify`.
6. **Record.** For anything a user would notice, add a line under *Unreleased*
   in CHANGELOG.md. If a hook, tool or stored file changes, update the README's
   *What it installs* and *Resource footprint*. Both are CONTRIBUTING rules.
   Set the row to `done` with the commit, commit (one row per commit), and push.
7. **Stop the turn** on any of these:
   - The same check fails twice on this row. Set it to `blocked` with the
     reason, and go to the next row on the next turn.
   - The row needs a choice only the user can make. Set it to `needs-decision`.
   - No row is `open`. Run `./bin/coplan check final` and end the loop.

Run it self-paced:

```
/loop Work the next open row of .claude/cleanup/PLAN.md, following its "One turn of the loop" section exactly. One row per turn. Stop when no row is open.
```

Or run it in Coplan itself. Publish these rows as a plan and submit it as a
*Managed* build: `.coplan/config.json` already runs implement → review →
refine per task, with these checks and a reviewing subagent.

**Pull requests:** CONTRIBUTING asks for one change per pull request. Open one
per Must-fix row, and one each for the clean-up phase and every refactor row.

## Ledger

Status: `open`, `done`, `blocked`, `needs-decision`. Numbers in brackets are
the audit's finding numbers.

| Row | What | Phase | Status | Commit |
|-----|------|-------|--------|--------|
| T1 | Test: a prompt the agent never got is taken back and handed over again; an edit in between blocks the take-back [18] | 0 safety net | done | acaa33a |
| T1b | Test through the hook route: a UserPromptSubmit whose relay gives up before the answer leaves keeps the prompt to deliver again (daemon/main.ts:1066-1110: close listener, `writableFinished`) [18] | 0 safety net | done in F19 (the take-back never fired, so the test came with the fix) | 5afa339 |
| T2 | Test: the live stream reconnects after an error (new ticket, new stream, session fetched again) and stops on 401 [18] | 0 safety net | done | 36e9fe2 |
| T3 | Test: each daemon sign-off route answers a refusal with 409 and the right text (pins [19c] before it moves) | 0 safety net | done | ee49ed6 |
| T4 | Test: the browser store's six sign-off actions adopt the plan, toast, and return false on refusal (pins [19d]) | 0 safety net | done | 6b72ecc |
| F1 | macOS: the hook relay never starts the daemon. Test: SessionStart with no `setsid` on PATH writes `daemon.json` [1] | 1 must fix | done | 74beb1d |
| F2 | The MCP server reports daemon 500, 413 and 400 answers as success [2] | 1 must fix | done | 01e68cf |
| F3 | `coplan stop` / `restart` cannot stop a hung daemon, and say they did [6] | 1 must fix | done | ea4fc79 |
| F4 | `upsert_task` with `builds` and removing a parent task slip past the unread-edit guard [5a] | 1 must fix | done | 2afd5e8 |
| F5 | Delivering the build prompt marks the user's later changes as read [5b] | 1 must fix | done | 9377052 |
| F6 | An agent push wipes what the user is typing in the box panel [3] | 1 must fix | done | 61e8112 |
| F7 | Saving the summary, box notes or a caption silently overwrites the agent's newer text [4]. D1: warn only | 1 must fix | done | 1e718e6 |
| F19 | A sign-off is marked delivered when the relay gave up while the daemon was busy, so the agent never gets it (found by T1b). See *F19* below | 1 must fix | done | 5afa339 |
| F20 | A proposal's staleness checks only the item each op names (and diagrams without their links), so accepting a proposed task removal or `builds` can take subtasks, dependencies or box links the user changed after it was proposed (`proposalTouches`, src/shared/plan.ts; found reviewing F4) | 2 should fix | done | 61b05ee |
| F21 | An editor left open while switching session saves into the session now on screen: the views are keyed by tab only, and task ids repeat across plans, so the summary, a section or a task can get another plan's text (src/ui/App.tsx:96, src/ui/views/*; found reviewing F7). In fact the views unmount on a switch; the gap was a focused field's blur save | 2 should fix | done | 11f4110 |
| F8 | `coplan init` writes `yarn check` / `bun test` / `pnpm ci`: always use `<pm> run <script>` [7] | 2 should fix | done | a65c44f |
| F9 | A Codex session first seen through MCP gets the daemon's folder: another repo's checks and git [9] | 2 should fix | done | f7fe757 |
| F10 | Plan sessions drop off the browser's list once 60 other sessions are newer [8] | 2 should fix | done | bdd70ec |
| F11 | A republish is refused for a box link to a task the agent dropped [10] | 2 should fix | done | b2db4bf |
| F12 | `move_task` makes a finished task a parent, and its finished work disappears [11] | 2 should fix | done | 3bcbdac |
| F13 | The brief says a dependency settled by dropping is "NOT DONE YET": use `isComplete` [12] | 2 should fix | done | 98d620a |
| F14 | A `.coplan/config.json` that starts with a BOM stops every check [13] | 2 should fix | done | fa3bd07 |
| F15 | Markdown: numbered steps split by blank lines restart at 1, `3.` renders as 1, fences inside a step break [14] | 2 should fix | done | 2890b1d |
| F16 | An open Markdown editor loses its text on a tab switch, a session switch or a tab close [15] | 2 should fix | done | b9085b9 |
| F17 | Ctrl+C on `coplan check` leaves the check running [16] | 2 should fix | done | 89e55b3 |
| F18 | A second setup run overwrites the `.bak` that holds the user's comments [17] | 2 should fix | done | d4746d8 |
| C1 | Delete dead UI code: unused primitives, format helpers and their CSS, plus the `.panel-title` rule that leaks onto live titles [20] | 3 clean-up | done | ff8770c |
| C2 | Delete dead daemon and shared code: `MODE_WORDS`, `checksSection`, `instructionLines`, `HOOK_EVENTS`, `clean`'s `trim`, Cursor tool-hook paths, the daemon's `--force`, `paths.sessionEvents`, `.diff.<pid>.tmp` sweep, the browser candidate loop [20] | 3 clean-up | done | 94cc1a8 |
| C3 | Drop the `@tailwindcss/cli` dev dependency (and `@parcel/watcher` with it) and the unread `CC_HARNESS_PLUGIN_ROOT` [20] | 3 clean-up | done | a6f491b |
| R1 | One `ensureDaemon()` for the CLI, the MCP server and the doctor, using the verified lock [19a]; fixes the doctor's stale-lock report | 4 refactor | done | d8fa57b, 7316969 |
| R2 | One "who spoke last" rule, exported from plan.ts, used in all four places [19b]; fixes the plan check and Revise button disagreeing | 4 refactor | done | ec359da |
| R3 | Map `PlanError` to 409 once in the daemon's top-level catch; delete six try/catch blocks; one `planOr404` [19c] | 4 refactor | done | 91cd7be |
| R4 | One `signOff` helper for the browser store's six sign-off actions; `commit` calls `adoptPlan` [19d] | 4 refactor | done | 08b50d7 |
| R5 | Merge `CommitInput` and `CommitTextArea` (after F6, so the fix lives in one place) [19e] | 4 refactor | done | 177744e, 267bcdb |
| R6 | Move `repoRoot` / `currentBranch` into `shared/changes.ts`; delete `daemon/git.ts` [19f] | 4 refactor | open | |
| R7 | Bind every edit to the session it was made in: `store.op`/`ops` take the view's session, as the canvas's `commit` does, instead of reading the one on screen when called (39 call sites; selectSession's blur covers today's editors only because each saves synchronously; found reviewing F21) | 4 refactor | open | |
| B1 | The relay exits 2 when `HOME` is unset, which blocks the prompt: `${HOME:-}` (bin/coplan-hook-relay.sh:78) | 5 smaller | open | |
| B2 | `sanitizeId` lets `.` and `..` through, and `purge` would delete the harness home (src/shared/paths.ts:29-31) | 5 smaller | open | |
| B3 | The MCP server exits on a `null` line; parse errors get no -32700 answer (src/mcp/main.ts:328-342) | 5 smaller | open | |
| B4 | A canvas save is refused, and undo cleared, when only the diagram's title changed mid-drag (FlowCanvas.tsx:269-372, plan.ts checkRev) | 5 smaller | open | |
| B5 | Tasks view copies: `derivedStatus`, `hasChildren`, three `isTyping` checks (TasksView.tsx:957-962, 1308-1316; lib/tasks.ts:41-45) | 5 smaller | open | |
| B6 | Check, then fix if real: Codex `additionalContextLimit: 4000` (hooks/codex.json:33) vs the 9000-character prompt budget (render.ts:431) | 5 smaller | open | |
| B7 | Check, then fix if real: the `findByCwd` fallback (daemon/main.ts:1135) can attach a Claude MCP call to a Codex or Cursor session in the same folder | 5 smaller | open | |
| B8 | `init` opens the stream twice when the session fetch answers before the ticket: `this.source` is set only once the ticket lands, so `if (!this.source) this.connect()` asks for a second ticket (the attempt guard drops the first stream). Harmless, but a wasted ticket per page load (src/ui/store.ts:164; found reviewing T2) | 5 smaller | open | |
| B9 | `coplan init` picks the package manager from lockfiles only, ignoring package.json's `packageManager` field: a repo with no lockfile yet (or a stray one) gets the wrong tool's `run` (src/cli/init.ts:46; found reviewing F8) | 5 smaller | open | |
| B10 | Check, then fix if real: when Cursor runs Claude Code's `hooks.json`, a huge `PostToolUse` names its session `conversation_id`, so the relay finds no `session_id` and drops it; and the slimmed payload loses `cursor_version`, which `hookAgent` reads (bin/coplan-hook-relay.sh:45, agentHooks.ts hookAgent; found reviewing C2) | 5 smaller | open | |
| B11 | `sessionOr404` throws `HttpError(404)` as `planOr404` does, so the daemon's ~20 routes drop their `if (!session) return;` and none can forget it (src/daemon/main.ts; found reviewing R3) | 5 smaller | open | |
| B12 | Enter in the panel's one-line fields (box label, detail, arrow label) saves while an IME is composing: check `e.nativeEvent.isComposing` (src/ui/components/flow/Panels.tsx CommitField; found reviewing R5) | 5 smaller | open | |
| A1 | Re-audit the touched areas with `/ponytail-audit`, and add any new findings as rows | 6 re-audit | open | |

### F19: the take-back never fires

Found while writing T1b (2026-11-10).

- **Case:** The daemon is busy (paused with SIGSTOP in the reproduction). The
  relay sends a UserPromptSubmit for a session with a submitted plan, then gives
  up: curl's `--max-time 4` (bin/coplan-hook-relay.sh:87) closes the socket.
  When the daemon resumes, it delivers the prompt, writes its answer into the
  closed socket, and keeps the plan marked delivered. The agent never got the
  prompt, and no later hook hands it over.
- **Measured:** with a normal close, 0 of 15 trials were taken back. With a
  reset, also 0 of 15.
- **Why:** onUserPromptSubmit runs without a single await once the body is
  read, so the answer is written before the daemon processes the close that is
  already waiting. `takeBack` then sees `writableFinished` and does nothing.
- **Tried:** waiting one `setImmediate` before the destroyed-check catches
  resets (15 of 15) but not a normal close (0 of 15), which is how curl gives
  up. Socket state is not a reliable signal here.
- **Fix:** the relay sends `x-harness-deadline: $(( $(date +%s) + MAX_TIME ))`.
  The hook route does not deliver, or takes back, a prompt it handles within
  about 1 s of that deadline. The prompt then goes out with the next message.
  It is late, but it is not lost. Keep the close-based take-back for resets.
- **Test (the pin):** an integration test that pauses the daemon with SIGSTOP,
  sends the hook through a raw socket with the deadline header, closes, sends
  SIGCONT, and asserts that the prompt is still pending and the next
  UserPromptSubmit hands it over. Skip it on win32.

## Decisions for the user

- **D1 (F7):** Warn in the browser only (about 3 lines: remember the value
  when editing starts, and show the existing "changed while you were editing"
  warning)? Or also refuse on the server, which needs a revision on the summary
  and `expect` on `set_meta`, a change to the agent API? **Decided: warn only,
  for now** (2026-11-10).

---

## Audit report (ponytail-audit, 2026-11-10)

What this repo does: Coplan is a plugin for Claude Code, Codex and Cursor. A
small daemon (a background server) on the user's own machine keeps the agent's
plan. The user shapes it in a browser page, and the agent reads and edits it
through an MCP server (the agent's tool bridge) and hooks (small scripts the
agent runs on events like "the user sent a prompt").

Load assumed: one developer's machine, one daemon, several agent sessions at
once in different repos, each firing hooks on every prompt and tool call, plus
one or a few browser tabs. Plans hold tens to a few hundred boxes and tasks. The
agent and the user edit the same plan, sometimes at the same moment.

How it was run: four reviewers read one layer each (daemon and hooks, the
shared plan model, CLI and MCP, browser UI), following this skill. Each finding
below was reproduced by running code, or checked by reading the lines named.

### Must fix

1. **On macOS the hook relay never starts the daemon** (`bin/coplan-hook-relay.sh:143`)
   - **What this is:** On a session's first event, the relay starts the daemon with `(setsid node … &) || (node … &)`.
   - **Problem:** A command put in the background always reports success, so the part after `||` never runs. macOS has no `setsid`, so nothing starts. Every new session waits 5 seconds, and a plan the user signs off after the daemon's idle shutdown misses the agent.
   - **Fix:** Start it through node, which runs everywhere: `node -e 'require("child_process").spawn(process.execPath,[process.argv[1]],{detached:true,stdio:"ignore"}).unref()' "$ENTRY"`. Add a relay test with no `setsid` on PATH. Today's test uses a fake daemon, so it passes either way.
   - **If we skip it:** Every Mac user gets slow session starts and sign-offs that sometimes never reach the agent.

2. **The agent is told a failed tool call worked** (`src/mcp/main.ts:193-201`)
   - **What this is:** The MCP server turns the daemon's answer into the tool result the agent sees.
   - **Problem:** It sets `ok` from `body.ok !== false` and ignores the HTTP status. A daemon crash (500 `{"error":"internal error"}`), an over-large body (413) or bad JSON (400) reaches the agent as success.
   - **Fix:** `ok: res.ok && body.ok !== false`, and show `body.error` when there is no `body.text`.
   - **If we skip it:** A publish that crashed looks stored, and the agent builds on a plan that is not there.

3. **An agent push wipes what the user is typing in the box panel** (`src/ui/components/flow/Panels.tsx:46`, `:102`)
   - **What this is:** A box's label, detail and description fields save when the user leaves the field.
   - **Problem:** Each field runs `useEffect(() => setDraft(value), [value])` with no guard. The user types into a description, and the agent publishes a new one for that box. The field switches to the agent's text while the user is still in it. On leaving, the draft equals the value, so nothing saves. Reproduced in jsdom.
   - **Fix:** Take a new value only when the draft still equals the last value shown (keep that value in a ref).
   - **If we skip it:** Users lose text with no trace, against the repo's own rule "never overwrite the user's edits blind".

4. **Saving the summary, a box's notes or a diagram caption overwrites the agent's newer text** (`src/ui/components/Editable.tsx:159-171`; callers `views/OverviewView.tsx:43-49`, `components/flow/Panels.tsx:276-283`, `views/DiagramsView.tsx:268-278`)
   - **What this is:** The Markdown editor warns "This changed while you were editing" only when it is given a `version`.
   - **Problem:** These three callers give none, and `set_meta` sends no `expect`. The user opens the summary to fix a typo, the agent rewrites the summary, and the user's Save replaces the agent's text with no warning.
   - **Fix:** With no `version`, remember the value when editing starts, and treat a different value as changed underneath. The existing warning then shows. About 3 lines.
   - **If we skip it:** The agent's rewrites of these fields vanish without anyone noticing.

5. **Two holes in "never overwrite the user's edits blind"** (`src/shared/plan.ts:991-1033`, `:2383-2398`)
   - **What this is:** An agent edit to something the user changed and the agent has not read is refused. The agent is shown the user's changes until it reads them.
   - **Problem:**
     - (a) The guard checks one key per edit. `upsert_task {builds: […]}` replaces the task's box links, and removing a parent task removes its subtasks. Neither is checked. The read-back then says "the user made edits, but they cancel out", which is false.
     - (b) Delivering the build prompt marks everything as read, including changes the user made after Submit, like rejecting a proposal with a reason. The agent never sees that reason. `markDesignDelivered` (`:2364-2376`) already handles this case. The build path does not.
   - **Fix:**
     - (a) Return a list of keys from `contentTargetOf`: every `diagram:*` key for `builds`, and every descendant for a task removal.
     - (b) Store `seq` on the submission and use `markDesignDelivered`'s condition.
   - **If we skip it:** The ground rule fails exactly when both sides link tasks to boxes, and rejection reasons get lost.

6. **`coplan stop` and `restart` cannot stop a hung daemon, and say they did** (`src/cli/main.ts:104-129`, `:138-165`)
   - **What this is:** `stop` sends SIGTERM once and prints "stopped pid N".
   - **Problem:** The daemon handles SIGTERM in JavaScript, so a blocked daemon never runs the handler and keeps living. `stop` exits 0 anyway, and `restart`'s `fetch` has no timeout, so it hangs.
   - **Fix:** After SIGTERM, wait up to about 3 s for the pid to die, then send SIGKILL and say so. Give `api()` `AbortSignal.timeout(5000)`.
   - **If we skip it:** The recovery command fails silently, and the user has to find the pid and `kill -9` it.

### Should fix

7. **`coplan init` writes checks that never run the repo's scripts** (`src/cli/init.ts:53`)
   - **What this is:** It turns package.json scripts into check commands as `<pm> <script>`.
   - **Problem:** `yarn check` is yarn's own integrity check: it passes without running the script. `bun test` is Bun's test runner, and `pnpm ci` fails.
   - **Fix:** Always write `<pm> run <script>`.
   - **If we skip it:** New repos get a final gate that always passes, or one that always fails.

8. **Plan sessions drop off the browser's list** (`src/daemon/store.ts:140`, `:185`)
   - **What this is:** Every agent session that fires a hook is stored, and only the 60 most recently updated stay in memory.
   - **Problem:** Plain sessions that never used Coplan push out an open plan session that was untouched for a few days. The plan is still on disk, but the browser and `coplan open` cannot see it.
   - **Fix:** Rank sessions that have a plan or were engaged ahead of the rest, then by `updatedAt`, in both places.
   - **If we skip it:** "My plan is gone" until that agent session happens to fire a hook again.

9. **A Codex session can get another repo's checks and git** (`src/daemon/store.ts:253`)
   - **What this is:** A session first seen through an MCP call is created with `cwd || process.cwd()`.
   - **Problem:** Codex's MCP server sends no folder, so the session gets the daemon's folder, which is the repo that started it. A Managed build then runs that other repo's checks and diffs its git.
   - **Fix:** `newSession(id, cwd || '', agent)`, so no repo is guessed until a hook supplies the real folder.
   - **If we skip it:** Codex builds pass or fail on another project's checks, with no warning.

10. **A republish is refused for a link the agent never wrote** (`src/shared/plan.ts:2609-2612`)
    - **What this is:** When a box's task links are not restated, the old links carry over and are then checked.
    - **Problem:** The agent republishes without a task the user had linked to a box, and the whole publish fails: `node "a" links task "t2", which is not in the plan`. `publishTasks` and `remove` quietly drop such links.
    - **Fix:** Filter the links that carry over against the new task list.
    - **If we skip it:** The agent has to guess that it must clear the user's links by hand.

11. **Moving a task under a finished one erases the finished work** (`src/shared/plan.ts:1374-1388`)
    - **What this is:** `upsert_task` refuses to give a started or finished task subtasks (`:1331-1336`). `move_task` does not check.
    - **Problem:** In a reopened plan the user moves t2 under t1, which is done. t1 then reads "ready", and the count drops from 1/2 done to 0/1.
    - **Fix:** Put the 6-line check in a helper and call it from `move_task` too.
    - **If we skip it:** Finished work disappears from the board and the counts.

12. **The task brief calls a settled dependency "NOT DONE YET"** (`src/daemon/brief.ts:355`, `src/daemon/render.ts:963`)
    - **What this is:** Both briefs decide "done" as "every leaf is done", a copy of `isComplete` (`src/shared/build.ts:102`).
    - **Problem:** `isComplete` also counts dropped leaves as settled. The board says a task is ready, while its brief says its dependency is not done.
    - **Fix:** Call `isComplete(plan, t.id)` in both places.
    - **If we skip it:** A subagent waits for, or redoes, work that was dropped on purpose.

13. **A config file saved with a BOM stops every check** (`src/shared/jsonc.ts:7-9`)
    - **What this is:** A BOM is an invisible marker some Windows editors put at the start of a file. `JSON.parse` rejects it.
    - **Problem:** A `.coplan/config.json` saved that way makes `coplan check` exit 2 with "nothing was run". The error names a character the user cannot see.
    - **Fix:** `JSON.parse(stripJsonc(text.replace(/^﻿/, '')))`.
    - **If we skip it:** Those repos never run their checks.

14. **Numbered steps and code inside steps render wrongly** (`src/ui/lib/markdown.ts:174`, `:243-249`, `:280-333`)
    - **What this is:** The hand-written Markdown renderer behind task details, notes and comments.
    - **Problem:** `1. a\n\n2. b\n\n3. c` becomes three lists that read "1. 1. 1.". A list starting at 3 shows 1. A code fence indented under a step is not seen as a fence.
    - **Fix:**
      - Keep the number and open `<ol start="N">`.
      - Allow leading spaces in the fence pattern and strip them from the code.
      - Add both cases to `markdown.test.ts`.
    - **If we skip it:** Step-by-step plans, the common shape of agent output, read wrongly.

15. **An open Markdown editor loses its text on a tab switch or tab close** (`src/ui/App.tsx:96`, `src/ui/store.ts:169-174`, `src/ui/components/Editable.tsx:153`)
    - **What this is:** The editor keeps its draft in component state and saves only on Save or Ctrl+Enter.
    - **Problem:** Views are keyed by tab, so clicking another tab, or a task's "Builds …" chip, unmounts the editor and drops the text. Closing the page does not ask first, because `beforeunload` only counts saves in flight.
    - **Fix:** Keep drafts in a module-level map, as `Submit.tsx`'s `useDraft` does, and count open drafts in the `beforeunload` check.
    - **If we skip it:** Long writing disappears on an ordinary click.

16. **Ctrl+C on `coplan check` leaves the check running** (`src/cli/check.ts:196-233`)
    - **What this is:** Each check runs `detached`, so a timeout can kill its whole process group.
    - **Problem:** Detached also means Ctrl+C does not reach it, and there is no signal handler. The suite keeps running, and a re-run starts a second copy.
    - **Fix:** On SIGINT or SIGTERM, kill the child's process group, then exit 130.
    - **If we skip it:** Orphaned suites fight over ports and `dist/`.

17. **A second setup run destroys the backup of the user's comments** (`src/cli/setup.ts:294-335`)
    - **What this is:** When a rewrite drops comments, `save` keeps `file.bak`.
    - **Problem:** `save` writes its own `//` header. On the next run that header counts as a comment, so the `.bak` holding the user's original is overwritten.
    - **Fix:** Ignore the header `save` writes, or never overwrite an existing `.bak`.
    - **If we skip it:** The user's comments are gone after the second `./setup.sh` that changes a setting.

18. **Risky code with no test that fails when it breaks** (`src/daemon/main.ts:1066-1110`, `src/ui/store.ts:205-264`)
    - **What this is:** Two pieces:
      - Taking back a prompt the agent never received, so a sign-off is delivered exactly once.
      - The browser's reconnect after a daemon restart.
    - **Problem:** No test touches either. The test setup's `EventSource` does nothing, and nothing in `src/test` names `undeliver` or `takeBack`.
    - **Fix:** One store-level take-back test, and one reconnect test with a recording `EventSource` and fake timers. These are rows T1 and T2.
    - **If we skip it:** A regression loses a sign-off, sends one twice, or leaves a page that never reconnects, and nothing fails.

19. **Copies that must change together, two of which already disagree**
    - **What this is:** The same rule written more than once.
    - **Problem:**
      - (a) "Find or start the daemon" is written three times (`src/cli/main.ts:29-51`, `src/mcp/main.ts:100-148`, `src/cli/doctor.ts:144-149, 482-496`). The doctor's copy only checks that the pid exists. After a reboot it reports 13 failures against a dead port and leaves its probe session behind.
      - (b) "Who spoke last in a thread" is written four times (`plan.ts:2407`, `render.ts:1385`, `ui/components/Threads.tsx:193`, `shared/check.ts:123`). The plan check flags a proposal thread that the Revise button ignores.
      - (c) Six daemon routes repeat the same `PlanError` → 409 try/catch (`src/daemon/main.ts:790-936`).
      - (d) Six browser sign-off actions repeat one wrapper (`src/ui/store.ts:333-500`).
      - (e) `CommitInput` and `CommitTextArea` are near-copies (`Panels.tsx:28-142`).
      - (f) There are two git helpers (`src/daemon/git.ts`, `src/shared/changes.ts:20-27`).
    - **Fix:** Keep one copy each: rows R1 to R6.
    - **If we skip it:** The copies keep drifting. (a) and (b) already have.

### Nice to have

20. **Dead code and an unused dependency**
    - **What this is:** Code nothing calls. The whole tree was grepped, including tests, scripts, hooks, skills and docs.
    - **Problem:** These are never used:
      - In the browser: `Button`, `Badge`, `Panel`, `Explain`, `Spinner` and `StatChip` in `ui/components/primitives.tsx`; `clockTime`, `splitPath`, `lineRef` and `pluralize` in `ui/lib/format.ts`; and their CSS.
      - In the shared code and renderer: `MODE_WORDS` (`build.ts:555`), `checksSection` and `instructionLines` (`render.ts`), `HOOK_EVENTS` (`hooks.ts`).
      - Cursor tool-hook handling for hooks Cursor no longer registers (`agentHooks.ts:30-32`, `bin/coplan-hook-relay.sh:46-49`).
      - In the daemon: its `--force` flag (`main.ts:88`), `paths.sessionEvents`, the `.diff.<pid>.tmp` sweep (`housekeeping.ts:207, 218`), and a browser-candidate loop that never moves on (`browser.ts:169-187`).
      - `@tailwindcss/cli` (the build compiles CSS in-process with `@tailwindcss/node`) and the `CC_HARNESS_PLUGIN_ROOT` variable in `.mcp.json`.

      The dead `.panel-title` rule also matches the live diagram title.
    - **Fix:** Delete them. These are rows C1 to C3.
    - **If we skip it:** Readers trust code that does nothing, and setup installs a native package nobody uses.

Seven smaller or unproven findings were left out of this list. They are rows B1 to B7.

Verdict: The codebase is well tested and mostly sound (682 passing tests, solid
locking, atomic saves, and Host and Origin checks on the HTTP API). Fix 1 and
2 first: both are small, and both make a failure look like success. Then fix
the lost-edit holes, 3 to 5.

Lean: -400 lines, -1 dependency possible (about; it also drops the native
`@parcel/watcher`).

Not checked:
- Real macOS, Codex and Cursor runs; the macOS finding was shown on Linux with `setsid` removed from PATH.
- A real browser: UI findings were reproduced in jsdom or read.
- Windows.
- Skimmed only: `render.ts` lines 681-1140, `brief.ts` outside lines 86-400, `architecture.ts`, `blocks.ts`, `agents.ts`, `types.ts`; the internals of `ui/lib/layout.ts`, `geometry.ts` and `graph.ts`; the components `PlanEdge`, `ContextMenu`, `Shortcuts`, `Export`, `GlobalActions`, `Handoff`, `Proposals`, `TaskChecks` and the Revisions dialog body; most of `style.css`.
- The restart handover race between a relay-started daemon and a respawned one.
