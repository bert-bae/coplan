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
| R6 | Move `repoRoot` / `currentBranch` into `shared/changes.ts`; delete `daemon/git.ts` [19f] | 4 refactor | done | 101ab73 |
| R7 | Bind every edit to the session it was made in: `store.op`/`ops` take the view's session, as the canvas's `commit` does, instead of reading the one on screen when called (39 call sites; selectSession's blur covers today's editors only because each saves synchronously; found reviewing F21) | 4 refactor | done | 8f17a7d, 46005bb |
| B1 | The relay exits 2 when `HOME` is unset, which blocks the prompt: `${HOME:-}` (bin/coplan-hook-relay.sh:78) | 5 smaller | done | 1d5f333 |
| B2 | `sanitizeId` lets `.` and `..` through, and `purge` would delete the harness home (src/shared/paths.ts:29-31) | 5 smaller | done | 234a27a |
| B3 | The MCP server exits on a `null` line; parse errors get no -32700 answer (src/mcp/main.ts:328-342) | 5 smaller | done | 76762e7 |
| B4 | A canvas save is refused, and undo cleared, when only the diagram's title changed mid-drag (FlowCanvas.tsx:269-372, plan.ts checkRev) | 5 smaller | done | 8564c6d |
| B5 | Tasks view copies: `derivedStatus`, `hasChildren`, three `isTyping` checks (TasksView.tsx:957-962, 1308-1316; lib/tasks.ts:41-45) | 5 smaller | done | d6c0118 |
| B6 | Check, then fix if real: Codex `additionalContextLimit: 4000` (hooks/codex.json:33) vs the 9000-character prompt budget (render.ts:431) | 5 smaller | done | 81f8572 |
| B7 | Check, then fix if real: the `findByCwd` fallback (daemon/main.ts:1135) can attach a Claude MCP call to a Codex or Cursor session in the same folder | 5 smaller | done | 2f22d53 |
| B8 | `init` opens the stream twice when the session fetch answers before the ticket: `this.source` is set only once the ticket lands, so `if (!this.source) this.connect()` asks for a second ticket (the attempt guard drops the first stream). Harmless, but a wasted ticket per page load (src/ui/store.ts:164; found reviewing T2) | 5 smaller | done | 0c625a9 |
| B9 | `coplan init` picks the package manager from lockfiles only, ignoring package.json's `packageManager` field: a repo with no lockfile yet (or a stray one) gets the wrong tool's `run` (src/cli/init.ts:46; found reviewing F8) | 5 smaller | done | 0c139a1 |
| B10 | Check, then fix if real: when Cursor runs Claude Code's `hooks.json`, a huge `PostToolUse` names its session `conversation_id`, so the relay finds no `session_id` and drops it; and the slimmed payload loses `cursor_version`, which `hookAgent` reads (bin/coplan-hook-relay.sh:45, agentHooks.ts hookAgent; found reviewing C2) | 5 smaller | done | fcb748f |
| B11 | `sessionOr404` throws `HttpError(404)` as `planOr404` does, so the daemon's ~20 routes drop their `if (!session) return;` and none can forget it (src/daemon/main.ts; found reviewing R3) | 5 smaller | done | cd9af1a |
| B12 | Enter in the panel's one-line fields (box label, detail, arrow label) saves while an IME is composing: check `e.nativeEvent.isComposing` (src/ui/components/flow/Panels.tsx CommitField; found reviewing R5) | 5 smaller | done | a919362 |
| B13 | What the page does after a late answer applies to the session now on screen: a sign-off's tab switch and toast, a moved task's refocus (`#task-<id>`), a new subtask's expand, a settled proposal's preview close, all keyed by ids that repeat across plans. Check the answer's session is still on screen first (src/ui/store.ts sign-offs, TasksView.tsx:590, 721, Proposals.tsx:39; found reviewing R7) | 5 smaller | done | 3a7519c |
| B14 | The six sign-offs still send to the session on screen when they run, not the one the dialog was opened on: give them its session as `commit` has, from `useSessionId`-style context (the dialogs already hold it for their previews). Guarded today by the daemon's `expect`/`hash` (src/ui/store.ts sign-offs, Submit.tsx, Revisions.tsx; found reviewing R7) | 5 smaller | done | bbdfe01 |
| B15 | The store's guard against overwriting a newer build's state records the folder name (sanitized) at load but checks the raw session id in `ensure`/`persistNow`, so an id `sanitizeId` changes (`a/b` → `a_b`) gets past it (src/daemon/store.ts `foreign`; found reviewing B2; the save was already refused, by `ensure` re-reading the file) | 5 smaller | done | 6eb3f6e |
| B16 | A parent task's row is styled by its own stored status (`is-${task.status}`) while its dot shows the status rolled up from its subtasks, so a parent whose subtasks are all done can still look to-do, in the outline and in "By box" (src/ui/views/TasksView.tsx outline row and ByBoxRow; found reviewing B5) | 5 smaller | done | b55775d |
| B17 | Per-plan page state is kept by bare ids across sessions: `collapsedTasks`, `proposalPreview` and `diagramId` are one list or value for every session, so collapsing t3 in one plan collapses another plan's t3 (src/ui/store.ts UiState; found reviewing B13; `diagramId` was already reset on a switch) | 5 smaller | done | c67e82e |
| B18 | A session a newer Coplan saved is served blank and never saved, and nothing on the page says so: edits made in it are gone on restart. Deleting it removes the newer build's folder, and its mark stays, so a session made later under that id is never saved either (src/daemon/store.ts `foreign`, `persistNow`, `purge`; found reviewing B15) | 5 smaller | done | 5777819 |
| B19 | Session ids that differ only where `sanitizeId` replaces a character, or past its 128-character cut, share one folder: `ensure` loads one's saved state under the other, and both save over the same file. Agents' ids are UUIDs today, so this needs an id from elsewhere (src/daemon/store.ts `ensure`, src/shared/paths.ts; found reviewing B15) | 5 smaller | done | 083023b |
| B20 | The canvas lists the tasks that build a box by each one's own stored status, so a parent whose subtasks are all done still shows a to-do dot there while the Tasks tab shows it done (src/ui/components/flow/Panels.tsx:300, 665, PlanNode.tsx:212; `shownStatus` in src/ui/lib/tasks.ts; found reviewing B16) | 5 smaller | done | a345cef |
| B21 | The session list shows a session a newer Coplan saved as an ordinary empty one: `summarize` leaves out `savedByNewer`, so it says so only once opened, and deleting it from the list deletes the newer build's plan with no warning (src/daemon/store.ts `summarize`, src/ui/components/Sidebar.tsx delete confirm; found reviewing B18) | 5 smaller | done | 31826a0 |
| A1 | Re-audit the touched areas with `/ponytail-audit`, and add any new findings as rows | 6 re-audit | done: 1 must fix, 8 should fix, 13 nice to have, now rows T5, F22-F29, B22-B33 and A2 | f6e0648 |
| T5 | Test the conflict guards for the diagram's graph and links: a canvas save based before `publishPlan` changed the graph, or before `publishTasks` relinked a box, is refused; a proposal restating a diagram's links goes stale once the user links a box. Each of plan.ts:462 (`graphRev` on publish), :754 (`bumpDiagram` sets it), :766 (`expect <= d.rev`) and :2247 (`diagramlinks:` key) can be deleted with every test passing [re-audit 9] | 0 safety net | done | 4ad067b |
| F22 | An agent `remove` of a task deletes a task the user moved under it since the agent last read: `unreadContent` counts only created/edited/deleted/published changes, so the move is not unread content. Removing the new parent takes the moved task and its detail; the same removal as a proposal is caught as stale (plan.ts:990-995, 1047-1050) [re-audit 1] | 1 must fix | done | 15fa98c |
| F23 | A sign-off queued with a revision request is lost when the relay gives up: since one prompt goes per message (B6), the revision stays queued after the sign-off is handed, so `!queued(...)` keeps `handed` unset and neither take-back fires (daemon/main.ts:1046; no test sends a deadline with both queued) [re-audit 2] | 2 should fix | done | 54f767b |
| F24 | Leaving a box field you never typed in saves over the agent's newer text: `useFieldDraft`'s `saved` follows each push but the draft does not while focused, so focus, agent push, blur commits the stale draft (an empty Description deletes the agent's); a one-line field saved with Enter saves again on leave over a newer rename (flow/Panels.tsx:38-70) [re-audit 3] | 2 should fix | done | 0261816 |
| F25 | CLI commands wait forever on a daemon that does not answer, and the doctor calls it reachable: `readVerifiedLock` keeps a `busy` lock and `api()` has no timeout nor `res.ok` check. `coplan status`, `clean`, `url`/`open` (no session in env) and `doctor` hang on a paused daemon (cli/main.ts:25-37, shared/paths.ts:119-125, cli/doctor.ts:142-147) [re-audit 4] | 2 should fix | done | fb8f3bc |
| F26 | A daemon started with nothing active exits at its first idle check, within about a minute: the check counts recent sessions and clients, not the daemon's own uptime, so the link `coplan start` or `coplan url` prints stops working unless a browser opens it at once; the log says "idle for 120m" (daemon/main.ts:1746-1756) [re-audit 5] | 2 should fix | done | da5abb7 |
| F27 | The comment composer and the Files field lose their text when their view goes (clicking another box, a tab or session switch), and closing the page does not ask: their text is component state, outside the kept drafts (components/Threads.tsx:149, views/TasksView.tsx:895, store.ts beforeunload) [re-audit 6] | 2 should fix | done | b9e02fe |
| F28 | Confirm design and Submit throw away a half-written draft without asking: the dialogs wait only for saves in flight, and once the plan locks `pruneDrafts` drops the kept draft (a summary started on Overview, a task detail), which was never in the prompt (components/Submit.tsx:379, 496; lib/drafts.ts:34-64) [re-audit 7] | 2 should fix | done | a15ed11 |
| F29 | A parent whose subtasks were all dropped shows ✓ Done, while the briefs say it was dropped whole and progress counts 0 done: `shownStatus` rolls up through `readinessOf`, which settles dropped leaves as done. Rewriting it over `leavesUnder` (all dropped → dropped, all settled → done, then in progress, blocked, else to do) fixes this and makes it about 20x faster (78 ms → 3.6 ms per row on 400 tasks); `boxRows` also rebuilds `outline` once per box (ui/lib/tasks.ts:23, 41-45) [re-audit 8] | 2 should fix | done: dropped shows dropped; outline numbered once. The faster roll-up was dropped: 6 ms to 4 ms for 400 rows here, not worth a second copy of readinessOf's rule | 162366f |
| F30 | Claude's `move_task` is not held against a move the user made that it has not read: the user moves t3 out of t1 to keep it, Claude (unread) moves it back under t1 and then removes t1, and t3 goes. Moves are left out of the unread-edit guard by design (`contentTargetsOf`: "none when it only … moves something"); refusing Claude's move of a task in `moved:` would close it, but it is a change to what the agent may do (found reviewing F22) | 2 should fix | needs-decision: D2 | |
| R8 | One kept-draft hook: MarkdownField (Editable.tsx), FilesField (TasksView.tsx) and the comment composer (Threads.tsx) each keep their draft in `openDrafts` by hand, and the copies drift (F27's review found FilesField missing the delete after a save and the reset after a refusal). A `useKeptDraft(field, value, version)` in drafts.ts would hold the key, the kept entry and its lifecycle for all three (found reviewing F27) | 4 refactor | done | e99e6a5, f989182 |
| B35 | A lock that comes another way (the agent confirming or submitting from chat, another tab) still drops text left open in a field it locks, without a word: `pruneDrafts` lets the draft go once `fieldText` says the field is locked. Say what was dropped, with its text to copy, when a kept draft goes because its field locked rather than because it was saved (ui/lib/drafts.ts `pruneDrafts`, store.ts snapshot; found reviewing F28) | 5 smaller | open | |
| B22 | B19's old-named folders are read only at boot, and `ensure`/`purge` know only the new name: a deleted `a:b` comes back on restart from `a_b`; one past the cap at boot gets a blank `a_b-<hash>` and its plan is never read again; a session whose id is `a_b` is served `a:b`'s saved state. Ignore saved state whose `sessionId` is not the id, read the old folder in `ensure` when it names this id, and remove it in `purge` (daemon/store.ts:153, 194, 276) [re-audit 10] | 5 smaller | open | |
| B23 | After starting the daemon, the relay waits up to 10 s from then, past the 10 s hook timeout of UserPromptSubmit/beforeSubmitPrompt: a slow cold start can mark a sign-off delivered after the agent killed the hook. Raise MAX_TIME only for SessionStart, or cap it to the time left (bin/coplan-hook-relay.sh:171, 201; comment at :101) [re-audit 11] | 5 smaller | open | |
| B24 | Two Escape handlers lack B12's `isComposing` guard: Escape that cancels an input-method candidate closes "add subtask" (`AddField`) or a box's task list, losing the typed title (components/Editable.tsx:327, flow/BoxTasks.tsx:133) [re-audit 12] | 5 smaller | open | |
| B25 | A session switch keeps the prompt viewer and the focus target: Back to another session shows its brief for the old task id, or the old sent prompt as its own; a jump made just before a switch flashes the other plan's item of that id (store.ts:199 `selectSession`) [re-audit 13] | 5 smaller | open | |
| B26 | An edit refused after a switch is toasted over the other plan without naming its own ("t3" means another task there), unlike the sign-offs since B13 (store.ts:361-371 `send` → `fail`) [re-audit 14] | 5 smaller | open | |
| B27 | A bare url inside a markdown link's text renders a link inside a link (`[see (https://a.com)](https://b.com)`), invalid HTML (ui/lib/markdown.ts:455) [re-audit 15] | 5 smaller | open | |
| B28 | The unread-edit guard clones the whole plan for every `upsert_task` with `builds`, even with nothing unread: 100 such ops on a 1.6 MB plan take 272 ms as the agent, up to about 0.5 s at MAX_OPS with the daemon blocked. Return early when nothing is unread (shared/plan.ts:1063-1066, 1096) [re-audit 16] | 5 smaller | open | |
| B29 | A proposed diagram removal does not go stale when the user links a task to one of its boxes, while a proposed box removal does: add `diagramlinks:<id>` for `remove` of kind diagram (shared/plan.ts:2266-2270) [re-audit 17] | 5 smaller | open | |
| B30 | A box linking both a parent and its subtask lists the subtask "via parent", with no Unlink, or above its parent: `direct` is set by walk order, not by `taskIds` (ui/lib/tasks.ts:26-34, flow/BoxTasks.tsx:207) [re-audit 18] | 5 smaller | open | |
| B31 | Ctrl+C on `coplan check` exits once the group leader does, before the SIGKILL that would stop a member ignoring SIGTERM: such a test runner or server stays running (cli/check.ts:241-252) [re-audit 19] | 5 smaller | open | |
| B32 | Dead re-export `export { sanitizeId }` in the store: everything imports it from shared/paths.ts (daemon/store.ts:778) [re-audit 20] | 5 smaller | open | |
| B33 | The MCP server runs a request whose id is neither string nor number and answers under id null: JSON-RPC calls it an Invalid Request (-32600), not to be run (mcp/main.ts:231, 347-351) [re-audit, left out of the report's 20] | 5 smaller | open | |
| B34 | A save against a revision the item has not reached (a buggy client, or a tab holding a plan since replaced) is refused as "was changed by Claude while this edit was open", though nobody changed it, so the cause stays hidden. Say the revision is newer than the item's (shared/plan.ts `checkRev`; found reviewing T5) | 5 smaller | open | |
| A2 | Re-audit the areas the rows after A1 touched with `/ponytail-audit`, and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing | 6 re-audit | open | |

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

- **D2 (F30):** The agent's `move_task` is not checked against the user's
  moves it has not read, by design ("none when it only … moves something").
  So it can move a task the user moved out of a subtree back under it, then
  remove the subtree, and the task goes: F22's guard, gone round in two
  steps. Options:
  - **Refuse the agent's move of a task the user moved since it last read
    the plan** (one line in `contentTargetsOf`: `move_task` targets
    `moved:<id>`, which F22 already records). The agent is told to read
    first, as for any unread edit. Cost: an agent reorganising the outline
    after the user dragged tasks about reads the plan first.
  - **Leave moves unchecked** (as now): the two-step loss stays possible.

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

---

## Re-audit report (row A1, ponytail-audit, 2026-11-10)

What this repo does: Coplan keeps a coding agent's plan in a small daemon on
the user's machine. The user shapes it in a browser page; the agent reads and
edits it through an MCP server and hooks. Load assumed: as in the first audit,
one machine, several agent sessions at once, one or a few tabs, plans of tens
to a few hundred tasks and boxes, the agent and the user sometimes editing the
same item at once.

How it was run: four reviewers, one layer each (daemon and hooks, the shared
plan model, CLI and MCP, browser UI), over what changed since 0cb836d and what
it touches. Nothing already in the ledger was reported again. Each finding was
reproduced with a script against the built code, or checked by reading the
lines named; the ledger rows above say which.

### Must fix

1. **An agent removal deletes a task the user moved under it** (`src/shared/plan.ts:990-995`, `:1047-1050`)
   - **What this is:** The unread-edit guard refuses an agent edit to anything the user changed since the agent last read the plan.
   - **Problem:** It counts only created, edited, deleted and published changes, not moves. The user drags t5 under t1; the agent, not having read since, removes t1, and t5 goes with it. The same removal sent as a proposal is caught as stale.
   - **Fix:** Count a task the user moved (its parent now differs from the agent's baseline) as unread content, and include it among what a removal takes. About 4 lines.
   - **If we skip it:** A subtree the user placed can be deleted blind, the loss the guard exists to stop.

### Should fix

2. **A sign-off queued with a revision request is lost when the relay gives up** (`src/daemon/main.ts:1046`)
   - **What this is:** The hook route takes a prompt back when the relay gave up before the answer reached the agent (F19).
   - **Problem:** Since one prompt goes per message (B6), the revision stays queued after the sign-off is handed, and the take-back requires nothing queued. The user revises, then submits; a late hook hands the build prompt to a closed socket and it stays marked delivered.
   - **Fix:** Drop `!queued(...)` from the condition; the check that the answer carried a queued prompt is enough, and the take-back restores both.
   - **If we skip it:** F19's loss returns for anyone who queues a revision and then signs off.

3. **Leaving a box field you never typed in saves over the agent's newer text** (`src/ui/components/flow/Panels.tsx:38-70`)
   - **What this is:** The box panel's fields save when you leave them.
   - **Problem:** The saved value follows each agent push while the draft does not, so a field you only clicked into looks changed. Click into an empty Description, the agent writes one, click away: it is deleted. The warning shown says leaving keeps your text.
   - **Fix:** Remember whether the user typed since entering the field; save on leave only then.
   - **If we skip it:** Clicking into a field is enough to undo the agent's work.

4. **CLI commands wait forever on a daemon that does not answer** (`src/cli/main.ts:25-37`, `src/shared/paths.ts:119-125`, `src/cli/doctor.ts:142-147`)
   - **What this is:** `coplan status`, `clean`, `url`, `open` and `doctor` talk to the daemon over HTTP.
   - **Problem:** A daemon that does not answer counts as running, and the requests have no timeout. On a paused daemon each of them hangs; the doctor first says "daemon reachable".
   - **Fix:** A default timeout and a status check in `api()`; the doctor says "not answering: run coplan restart" for a busy daemon.
   - **If we skip it:** The commands people are told to run to diagnose hang exactly when the daemon is the problem.

5. **A daemon started with nothing active exits within a minute** (`src/daemon/main.ts:1746-1756`)
   - **What this is:** The daemon exits once no browser is open and no session was active within the idle time.
   - **Problem:** It never counts its own start. `coplan start` or `coplan url` with no active session prints a link that is dead a minute later unless a browser opens it at once. The log says "idle for 120m".
   - **Fix:** Count idle time from the later of the daemon's start and the last activity.
   - **If we skip it:** The link the CLI prints often does not work.

6. **Comments and the Files field lose their text when their view goes** (`src/ui/components/Threads.tsx:149`, `src/ui/views/TasksView.tsx:895`)
   - **What this is:** F16 kept open drafts across unmounts, for markdown fields only.
   - **Problem:** A comment typed on a box is gone when the user clicks another box; the same on a tab or session switch, and for an open Files edit. Closing the page does not ask about them.
   - **Fix:** Keep their text in a map by session and target, as Submit's drafts do, and count it before unload.
   - **If we skip it:** Ordinary clicking loses typed comments.

7. **Confirm design and Submit throw away a half-written draft without asking** (`src/ui/components/Submit.tsx:379`, `:496`; `src/ui/lib/drafts.ts:34-64`)
   - **What this is:** A draft left open in a field is kept until saved or until its field is locked.
   - **Problem:** The dialogs wait only for saves in flight. A summary half-written on Overview, then Confirm design on Architecture: the plan locks and the draft is dropped, never in the prompt.
   - **Fix:** Count open drafts for the session among what the dialogs wait for, with a title saying which field to save or cancel.
   - **If we skip it:** The page asks before closing the tab but not before a sign-off that loses the same text.

8. **A parent whose subtasks were all dropped shows as Done, and working out a parent's status is slow** (`src/ui/lib/tasks.ts:23`, `:41-45`)
   - **What this is:** A parent's shown status is rolled up from its subtasks (B16, B20).
   - **Problem:** The roll-up goes through build readiness, which counts dropped as settled, so all-dropped shows ✓ Done while the briefs say dropped and progress counts 0 done. It also works out ready versus waiting for every leaf only to show both as to do: 78 ms per row on 400 tasks; `boxRows` rebuilds the outline per box.
   - **Fix:** Roll up over the leaves directly (all dropped → dropped, all settled → done, then in progress, blocked, else to do), about 20 times faster; build the outline once per render.
   - **If we skip it:** The page says dropped work is done, and the Tasks view stutters on large plans.

9. **The guards against stale canvas saves and proposals have no test that fails** (`src/shared/plan.ts:462`, `:754`, `:766`, `:2247`)
   - **What this is:** The diagram's graph revision (B4) and the link staleness keys (F20).
   - **Problem:** Each of these lines can be deleted with every test passing; together, a canvas save from before the agent republished drops the agent's new box, and accepting a stale proposal wipes a link the user made.
   - **Fix:** Three plan tests: a graph save after `publishPlan`, one after `publishTasks` relinks a box, and a proposal restating links after the user links a box.
   - **If we skip it:** A refactor can remove them silently.

### Nice to have

10. **B19's old-named folders are read only at boot** (`src/daemon/store.ts:153`, `:194`, `:276`) — a deleted `a:b` returns on restart; one past the cap at boot loses its plan; a session whose id is `a_b` is served `a:b`'s state. Ignore saved state for another id; read and remove the old folder in `ensure` and `purge` too.
11. **After a cold start the relay waits past the hook's own timeout** (`bin/coplan-hook-relay.sh:171`, `:201`) — a slow start can mark a sign-off delivered after the agent killed the hook. Raise the wait only for SessionStart.
12. **Two Escape handlers lack the input-method guard** (`src/ui/components/Editable.tsx:327`, `src/ui/components/flow/BoxTasks.tsx:133`) — cancelling a candidate closes the field and loses the title.
13. **A session switch keeps the prompt viewer and the focus target** (`src/ui/store.ts:199`) — the viewer shows the other plan's brief for the old task id; a jump flashes the other plan's item.
14. **An edit refused after a switch does not name its plan** (`src/ui/store.ts:361-371`) — "t3" in the toast means another task on screen.
15. **A bare url inside a link's text renders a link in a link** (`src/ui/lib/markdown.ts:455`).
16. **The unread-edit guard clones the plan for every `builds` edit** (`src/shared/plan.ts:1063-1066`) — up to about 0.5 s per call on a big plan; return early when nothing is unread.
17. **A proposed diagram removal ignores links made since; a box removal does not** (`src/shared/plan.ts:2266-2270`).
18. **A box linking a parent and its subtask lists the subtask as reached through its parent** (`src/ui/lib/tasks.ts:26-34`) — no Unlink for it there.
19. **Ctrl+C on `coplan check` can leave a member that ignores SIGTERM running** (`src/cli/check.ts:241-252`).
20. **A dead re-export in the store** (`src/daemon/store.ts:778`).

One smaller finding was left out of this list (the MCP server runs a request
whose id is not a string or number); it is row B33.

Verdict: one data-loss bug (1) to fix first, then the lost sign-off (2) and the
box field that saves over the agent (3).

Lean: -1 line possible (20).

Not checked: main.ts routes the cleanup did not change, render.ts and brief.ts
outside their changed lines, the canvas lib (layout, geometry, history), several
UI components (PlanEdge, ContextMenu, Shortcuts, Toasts, Handoff), the MCP tool
definitions beyond their names, and real runs on macOS, Windows, Codex and
Cursor.
