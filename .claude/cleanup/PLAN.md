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
| F30 | Claude's `move_task` is not held against a move the user made that it has not read: the user moves t3 out of t1 to keep it, Claude (unread) moves it back under t1 and then removes t1, and t3 goes. Moves are left out of the unread-edit guard by design (`contentTargetsOf`: "none when it only … moves something"); refusing Claude's move of a task in `moved:` would close it, but it is a change to what the agent may do (found reviewing F22) | 2 should fix | needs-decision: D2, asked in bert-bae/coplan#81 | |
| R8 | One kept-draft hook: MarkdownField (Editable.tsx), FilesField (TasksView.tsx) and the comment composer (Threads.tsx) each keep their draft in `openDrafts` by hand, and the copies drift (F27's review found FilesField missing the delete after a save and the reset after a refusal). A `useKeptDraft(field, value, version)` in drafts.ts would hold the key, the kept entry and its lifecycle for all three (found reviewing F27) | 4 refactor | done | e99e6a5, f989182 |
| B35 | A lock that comes another way (the agent confirming or submitting from chat, another tab) still drops text left open in a field it locks, without a word: `pruneDrafts` lets the draft go once `fieldText` says the field is locked. Say what was dropped, with its text to copy, when a kept draft goes because its field locked rather than because it was saved (ui/lib/drafts.ts `pruneDrafts`, store.ts snapshot; found reviewing F28) | 5 smaller | done | 493d838 |
| B22 | B19's old-named folders are read only at boot, and `ensure`/`purge` know only the new name: a deleted `a:b` comes back on restart from `a_b`; one past the cap at boot gets a blank `a_b-<hash>` and its plan is never read again; a session whose id is `a_b` is served `a:b`'s saved state. Ignore saved state whose `sessionId` is not the id, read the old folder in `ensure` when it names this id, and remove it in `purge` (daemon/store.ts:153, 194, 276) [re-audit 10] | 5 smaller | done | 72dddaf |
| B23 | After starting the daemon, the relay waits up to 10 s from then, past the 10 s hook timeout of UserPromptSubmit/beforeSubmitPrompt: a slow cold start can mark a sign-off delivered after the agent killed the hook. Raise MAX_TIME only for SessionStart, or cap it to the time left (bin/coplan-hook-relay.sh:171, 201; comment at :101) [re-audit 11] | 5 smaller | done | 185dd4f |
| B24 | Two Escape handlers lack B12's `isComposing` guard: Escape that cancels an input-method candidate closes "add subtask" (`AddField`) or a box's task list, losing the typed title (components/Editable.tsx:327, flow/BoxTasks.tsx:133) [re-audit 12] | 5 smaller | done | a7192e6 |
| B25 | A session switch keeps the prompt viewer and the focus target: Back to another session shows its brief for the old task id, or the old sent prompt as its own; a jump made just before a switch flashes the other plan's item of that id (store.ts:199 `selectSession`) [re-audit 13] | 5 smaller | done | 83b54ef |
| B26 | An edit refused after a switch is toasted over the other plan without naming its own ("t3" means another task there), unlike the sign-offs since B13 (store.ts:361-371 `send` → `fail`) [re-audit 14] | 5 smaller | done | 238b8ef |
| B27 | A bare url inside a markdown link's text renders a link inside a link (`[see (https://a.com)](https://b.com)`), invalid HTML (ui/lib/markdown.ts:455) [re-audit 15] | 5 smaller | done | ff8cf5c |
| B28 | The unread-edit guard clones the whole plan for every `upsert_task` with `builds`, even with nothing unread: 100 such ops on a 1.6 MB plan take 272 ms as the agent, up to about 0.5 s at MAX_OPS with the daemon blocked. Return early when nothing is unread (shared/plan.ts:1063-1066, 1096) [re-audit 16] | 5 smaller | done: the guard asks `buildsChange`, which reports the links without changing anything, so no copy whatever is unread (an early return alone left a copy per op once anything was unread) | 2d58746 |
| B29 | A proposed diagram removal does not go stale when the user links a task to one of its boxes, while a proposed box removal does: add `diagramlinks:<id>` for `remove` of kind diagram (shared/plan.ts:2266-2270) [re-audit 17] | 5 smaller | done | 88d4803 |
| B30 | A box linking both a parent and its subtask lists the subtask "via parent", with no Unlink, or above its parent: `direct` is set by walk order, not by `taskIds` (ui/lib/tasks.ts:26-34, flow/BoxTasks.tsx:207) [re-audit 18] | 5 smaller | done | cfafd82 |
| B31 | Ctrl+C on `coplan check` exits once the group leader does, before the SIGKILL that would stop a member ignoring SIGTERM: such a test runner or server stays running (cli/check.ts:241-252) [re-audit 19] | 5 smaller | done: it leaves once the group has gone, or at the SIGKILL three seconds on; the timeout path's gap is row B36 | 26788c7 |
| B32 | Dead re-export `export { sanitizeId }` in the store: everything imports it from shared/paths.ts (daemon/store.ts:778) [re-audit 20] | 5 smaller | done | e63a075 |
| B33 | The MCP server runs a request whose id is neither string nor number and answers under id null: JSON-RPC calls it an Invalid Request (-32600), not to be run (mcp/main.ts:231, 347-351) [re-audit, left out of the report's 20] | 5 smaller | done: null too, which MCP rules out | a46f633 |
| B34 | A save against a revision the item has not reached (a buggy client, or a tab holding a plan since replaced) is refused as "was changed by Claude while this edit was open", though nobody changed it, so the cause stays hidden. Say the revision is newer than the item's (shared/plan.ts `checkRev`; found reviewing T5) | 5 smaller | done: tasks too, which let such an edit through; and a revision below 1 or not whole | 3b5c32e |
| B36 | A check that times out has the rest of its group killed only by an unref'd timer, three seconds on, and its close is reported at once: a worker that ignores SIGTERM with its output redirected runs beside the next check, and on past `coplan check` if it ends first. Share the interrupt's wait for the group (cli/check.ts `stop`; found reviewing B31) | 5 smaller | done: one joined stop for both, and a check whose output is held open from outside now ends; the normal-exit path is row B37 | acd9060 |
| B37 | A check that exits on its own is over only when its output closes: something it started out of its group holding that open (a dev server started detached) makes it run to its timeout and fail as timed out, though its exit code is known; and what it left running in its group (a stray test worker, its output redirected) runs on beside the next check. End it as a stopped one ends: on its exit, the rest of its group stopped, its output read or let go a moment on (cli/check.ts `runHook`; found reviewing B36) | 5 smaller | done: the output half; stopping what is left in its group is B38 (D3) | 1958574 |
| B38 | A check that exits on its own while something it started still runs in its group (a stray test worker, a server started with `&` and its output redirected) is over at once, and that runs on beside the next check and past `coplan check`. Stopping the rest of the group on exit would end it, but also a server a check starts for the checks after it (split from B37) | 5 smaller | needs-decision: D3, asked in bert-bae/coplan#82 | |
| A2 | Re-audit the areas the rows after A1 touched with `/ponytail-audit`, and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing | 6 re-audit | done: no must fix, 7 should fix, 9 nice to have, now rows T6, F31-F36, B39-B47 and A3; D3 amended | fb5c76d |
| T6 | Three guards in the store's code for folders an earlier build named have no test that fails when they break (each removed alone, the store and integration tests still pass): `purge` deletes the old folder only when `ownerOf(old) === id`, else deleting `a:b` deletes the plan of session `a_b`; `readSaved` moves another session's state only when that session has none of its own, else an old copy goes over its newer one; and it serves an old folder only when it holds the id asked for, else `a:b` is served `a_b`'s plan. One store test each (daemon/store.ts:197, 303, 315) [re-audit A2 7] | 0 safety net | done: two tests, each guard removed alone fails one | 8786ead |
| F31 | A proposal's inner `expect` is checked as the user's (its trial runs `applyAsUser`): a stale task `expect` the agent would be refused directly goes through, and accepting it overwrites the user's newer text; the agent's own successive edits are refused instead, and sections and diagrams name the wrong side. Check inner `expect`s as Claude's when the proposal is made (shared/plan.ts:1649-1653, 2183, 2987-2993) [re-audit A2 1] | 2 should fix | done: every `expect` is checked once, before the batch (expectAtStart), as its reader's; a proposal's as Claude's | 93a6874 |
| F32 | A proposal's ops are guarded, and printed for staleness, against the plan before it, not as its earlier ops leave it, as a batch is: `[move_task t3 under t1, remove t1]` passes though the user's unread edit of t3 would be refused in a batch, and stays acceptable after the user links a box or adds a dependency to t3, which accepting then drops (its preview is cached on the unchanged print). Guard each inner op on the trial copy, and print a `move_task` with the moved task's removal footprint (shared/plan.ts:1278-1280, 2222-2304) [re-audit A2 2] | 2 should fix | done: guarded in the proposal's trial; a removal's print counts the proposal's earlier moves (not every move's footprint, which would stale a move alone) | 0dacb65 |
| F33 | A progress note (`harness_task_update`, a note with a status) changes `task.note` without moving the task's revision, which the note editor relies on: the user's note editor, opened before the agent's "Blocked: DB creds missing", saves over it with no conflict. Move `rev`/`revBy` when the note changes (shared/plan.ts:1823-1828, 1906-1910) [re-audit A2 3] | 2 should fix | done another way: the note editor sends the note it started from (`noteWas`), refused if it changed; moving the revision would refuse every other open editor of the task at each progress note | 18146db |
| F34 | An unsent comment or reply is not held by the plan lock, though a submitted plan refuses the user's comments: Submit does not wait for it, a lock from chat drops it without B35's copy toast, its box goes, and the page asks before closing until reloaded. `fieldText` should take comment and reply drafts as locked once the plan is, with a name in `fieldName` (ui/lib/drafts.ts:87-90) [re-audit A2 4] | 2 should fix | done: and the comment box and Reply hide on a locked plan | 0352043 |
| F35 | A reply being typed vanishes when the agent resolves its thread: `fieldText` drops it and the thread moves to the hidden resolved list, with no toast, though a resolved thread still takes replies. Keep it while its thread exists (ui/lib/drafts.ts:89-90, components/Threads.tsx:66-75) [re-audit A2 5] | 2 should fix | done: kept and in sight, and the user's reply opens the thread again, as a resolved one is not the agent's to hear | 0ec6431 |
| F36 | Ctrl+C on `coplan check` whose stderr reader has gone (`2>&1 | head`, an agent that closed the pipe) crashes on the EPIPE from `process.stderr.write`, after the SIGTERM but before the wait and the SIGKILL: what ignores SIGTERM runs on. Use `console.error`, which ignores write errors (cli/check.ts:312) [re-audit A2 6] | 2 should fix | done: and the CLI lets an EPIPE on stdout or stderr go, from its entry | 4f6152c |
| F37 | The agent's progress note goes over a note of the user's it has not read: the user writes "Creds are in the vault" in t3's note, and the agent, unread, reports `{status: 'blocked', note: 'Blocked: DB creds missing'}` through harness_task_update; the unread-edit guard leaves a note with a status out by design (`contentTargetsOf`: a progress report), and the user's note is gone. Hold a progress note to an unread change of the note (shared/plan.ts `contentTargetsOf`; found reviewing F33) | 2 should fix | done | a0cfc0a |
| B39 | Every removal copies the whole plan, only to describe the comments it leaves without a home: 40 removals on a 5.4 MB plan hold the daemon about 0.9 s, paid again on a proposal's preview and accept. A shallow `{ ...plan }` does, as the removal reassigns its lists rather than changing them (shared/plan.ts:2000) [re-audit A2 8] | 5 smaller | done: 938 ms to 102 ms | 503fa5b |
| B40 | A diagram whose links Claude changed (removing a task, a task list's builds) keeps the last design editor as `updatedBy`, so a conflict on it says "changed by another edit"; and `checkRev` tells Claude "It now shows the latest version" where a task's says to read the plan again. `bumpDiagram` takes the author (shared/plan.ts:760-764, 2938) [re-audit A2 9] | 5 smaller | done: a drag still leaves updatedBy (the agent's read says who last edited) | b22a531 |
| B41 | A check's own timeout that falls in the 200 ms let-go after it ended on its own reports it as timed out: clear the timer once it has ended (cli/check.ts:290-299) [re-audit A2 10] | 5 smaller | done: the timer asks whether it ended, group and all | bae946e |
| B42 | A hook whose `cwd` is a file passes `existsSync`, and `spawn` then throws ENOTDIR inside the promise: `coplan check` prints a stack and the checks after it never run. Ask for a directory (cli/check.ts:191) [re-audit A2 11] | 5 smaller | done: and a spawn that throws fails that check alone; the config warns of a file `cwd` | 160b55a |
| B43 | Clicking Reply again on a reply being written empties it (`begin` starts it afresh): leave an open editor as it is (components/Threads.tsx:100, ui/lib/drafts.ts:172-176) [re-audit A2 12] | 5 smaller | done: Reply hides while open, as every other editor's trigger does | 91d4f6f |
| B44 | A section's comment box sits inside the summary's fieldset, disabled once the design is confirmed, though comments are open until the plan is submitted: a comment written there is stuck, and the page asks before closing. Move the comment panels out of it (views/OverviewView.tsx:40) [re-audit A2 13] | 5 smaller | done: and Resolve leaves a submitted plan's threads | 22dee12 |
| B45 | No test holds a toast with text to copy up past its 8 s: dropping `copy === undefined` would let the only copy of a dropped draft vanish (ui/store.ts:796) [re-audit A2 14] | 5 smaller | done | 854c4e0 |
| B46 | An earlier build run again after a session moved to its hashed folder serves the stale old folder, and its edits there are then ignored by the new build. Remove the old folder once moved, when it is the session's (`ownerOf`), or take the later `updatedAt` (daemon/store.ts:149-162, 276, 313-316) [re-audit A2 15] | 5 smaller | done, then superseded by F38: the own folder wins once it holds a copy (the newest-by-time rule lost work) | 693db5f |
| B47 | Ids with lone surrogates hash alike (`createHash().update(id)` encodes each as U+FFFD), so `"s\ud800"` and `"s\udbff"` share a folder. Hash the id as `utf16le`; the hashed names are not released yet (shared/paths.ts:41) [re-audit A2 16] | 5 smaller | done | 7722531 |
| A3 | Re-audit the areas the rows after A2 touched with `/ponytail-audit`, and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing | 6 re-audit | done: no must fix, 4 should fix, 6 nice to have, now rows F38-F41, B48-B53 and A4 | 30f7435 |
| F38 | B46's newest-copy rule loses work: (a) once a session's old-folder copy is taken and saved with the same time, a change that moves no time (ensure learning its folder) ties at the next start and readdir order picks the old copy, saved back over the own; (b) an earlier build's hook stamping its stale old copy newer overwrites an hour of work in the own folder, with no trace on disk; (c) an old copy dated ahead of the clock reverts the session at every start; (d) another session's first save destroys a newer old copy of a session past the memory cap. Go back to the own folder winning whenever it holds a readable copy, keeping B46's other fixes (newer build's and other sessions' folders left alone, expired cleared first, ensure saving what it took, unreadable own giving way) (daemon/store.ts:168-176, 320-330; found re-auditing B46) [re-audit A3 1] | 2 should fix | done: back to the own folder winning; B46's goal (work done in an earlier build run again) given up | 4499aa9 |
| F39 | Closing the terminal during `coplan check` crashes it before the check is stopped: SIGHUP, then the interrupt message's write fails with EIO, which F36's guard (EPIPE only) rethrows; a worker ignoring SIGTERM runs on (reproduced under a pty: exit 1 after 0.01 s). Let any write error on stdout or stderr go (cli/main.ts:422) [re-audit A3 2] | 2 should fix | done: EIO let go as EPIPE is; other write errors still end it | e98379f |
| F40 | A save refused as changed underneath (the note editor's `noteWas`, a title's revision) reopens with the user's text on the new base, and the next blur, a click anywhere, saves it over the newer text the refusal was about: the agent's "Blocked: DB creds missing" is gone after all. After a refusal, leave the field only by Enter (save) or Escape (drop), showing what is there now (components/Editable.tsx:83-91, 109) [re-audit A3 3] | 2 should fix | done: only when the text changed underneath; other failures retry on leaving as before | 6f16197 |
| F41 | Trimming the change log (500 entries) hides unread user edits from the unread-edit guard, which compares only items still in the log: the user edits t3's detail and note, 500 other changes follow (comments, status clicks) before the agent reads, and its edit of t3 and its progress note both go over the user's. Compare every item in the baseline when the log has a gap since Claude's read, or never trim what Claude has not read (shared/plan.ts:148, 1001-1006) [re-audit A3 4] | 2 should fix | done: both: unread user changes kept when trimming (bounded), and the whole baseline compared on a gap | 8d2e58b |
| B48 | A proposed removal's print misses a task the proposal moves under a task it adds itself (`[add t9 under t1, move t3 under t9, remove t1]`): the user's link or dependency on t3 made after it is dropped on accept, not refused as out of date. Give `movedTo` the added tasks' parents (shared/plan.ts:2341-2342, 2379-2382; found re-auditing F32) [re-audit A3 5] | 5 smaller | done | 4a3fee1 |
| B49 | A proposal's `expect` is checked against the plan as the batch's earlier direct edits left it: `[upsert_section s1 body expect 1, propose [upsert_section s1 title expect 1]]` is refused, and on any revision again. Check it against the batch's start (shared/plan.ts:1728, 2263; found re-auditing F31) [re-audit A3 6] | 5 smaller | done | 631aad9 |
| B50 | A proposal's staleness print leaves a task's note out: the user rewriting t3's note after the agent proposed a note for it does not put the proposal out of date, and accepting it writes over theirs. Print a proposed note as `note:<id>` (shared/plan.ts:2324) [re-audit A3 7] | 5 smaller | done | 403a92d |
| B51 | A submitted plan still offers a section's "Comment on …" button, which opens an empty panel: show it only while the plan takes comments or the section has some, as the diagrams do (views/OverviewView.tsx:156; found re-auditing B44) [re-audit A3 8] | 5 smaller | done | b00a91f |
| B52 | A comment or reply a lock dropped (toasted with Copy) comes back in its box when the plan is reopened, but untracked: no close prompt, and a tab switch empties it. Clear the composer when the lock drops it (components/Threads.tsx:60, 82, 123; found re-auditing F34) [re-audit A3 9] | 5 smaller | done | e2cde86 |
| B53 | A hook folder that cannot be entered (no search permission) passes the stat and fails as `spawn sh EACCES`, exit 127, as if the shell were missing: check access in the same try (cli/check.ts:194-198; found re-auditing B42) [re-audit A3 10] | 5 smaller | done | 65b63ff |
| B54 | A proposed task removal ignores the notes it deletes: the user rewriting t3's (or a subtask's) note after the agent proposed removing t3 does not put the proposal out of date, and accepting it deletes the note. Print the doomed tasks' notes in `removal:<id>` (shared/plan.ts proposalTouches) [review of B50] | 5 smaller | done | c6f0216 |
| A4 | Re-audit the areas the rows after A3 touched with `/ponytail-audit`, and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing | 6 re-audit | done: no must fix, 4 should fix, 7 nice to have, now rows F42-F44, T7, B55-B61 and A5 | 564fd56 |
| F42 | Ctrl+C with stderr on a full disk crashes `coplan check` before its check is stopped: the interrupt message fails with ENOSPC, which the F39 guard rethrows, so the SIGKILL three seconds later never comes and a worker that ignores SIGTERM runs on. Reproduced with `2>/dev/full`. Let stderr ignore every write error; keep the rethrow on stdout, where the report goes (cli/main.ts:421-425) [re-audit A4 1] | 2 should fix | done: stderr lets every error go, and a check's group is killed when the command exits any other way | e2ce697 |
| F43 | After a save refused as changed underneath (F40), leaving by unmounting the field (a tab switch, closing a task's Details, a session switch) drops the user's text without a word: no toast with Copy, no close prompt. Before F40 the blur saved it. Offer it to copy when the field goes while refused (components/Editable.tsx:119, 135-143) (bert-bae/coplan#85) [re-audit A4 2] | 2 should fix | done: offered to copy when the field unmounts while refused, or its save is refused after it went | 626e55d |
| F44 | A submitted plan's task comments, and the agent's replies to them, cannot be read anywhere: the locked Tasks tab is the board, whose cards show no comments. B51's guard in TaskRow never runs (TaskRow is not drawn on a locked plan), so its test's task assertion is vacuous. Show the task's comments on the board card, read only; drop the dead guard; make the test read them there (views/TasksView.tsx:59, 562, 1105) (bert-bae/coplan#84) [re-audit A4 3] | 2 should fix | done: a card with comments shows them to read; the dead guard is dropped | af91fd1 |
| F45 | `coplan check --json > report.json` on a full disk exits 0 with nothing written: the CLI calls process.exit before stdout's ENOSPC 'error' is emitted, so the stdout rethrow never runs. Reproduced with `> /dev/full`, before and after F42. Flush stdout before exiting, and fail if it could not be written (cli/main.ts:427-440) (bert-bae/coplan#86) [found in F42] | 2 should fix | done: exits once stdout is flushed, 1 when it could not be written | f4fc69e |
| F46 | A plan title refused as changed underneath (F40) stays open across a session switch: the header's InlineText is not keyed by session, so it does not unmount, and Enter then saves the text written for plan A over plan B's title (`set_meta` carries no revision). Key it by session, so F43's offer gives the text to copy (App.tsx:84, 171) (bert-bae/coplan#95) [review of F43] | 2 should fix | done: not reproduced (a switch unmounts the header through Loading, and F43 offers the text); keyed by session and pinned | 01b3bee |
| F47 | After F44, a submitted plan's comments on a parent task are still unreadable (the board draws leaves only), and By box mode shows no task comments at all (TasksView.tsx Board, ByBoxRow) (bert-bae/coplan#97) [review of F44] | 2 should fix | done: parents with comments listed above the board; By box rows get the toggle | a96ccd7 |
| T7 | Test: a copy in a session's old folder is not loaded over its own folder's file from a newer build (`newer.has(own)` in load). Removing that guard passes every store test, and would write the old copy over the newer build's plan on a downgrade (daemon/store.ts:167; store.test.ts:432) (bert-bae/coplan#87) [re-audit A4 4] | 0 safety net | done: load and ensure both held (each guard mutated) | 4fe24fe |
| B55 | Load's last loop checks `this.sessions.has` before persistNow, which returns for a session not in memory already: drop it (daemon/store.ts:175) (bert-bae/coplan#88) [re-audit A4 5] | 5 smaller | done: walks the loaded sessions instead; past-the-cap pinned | c09c270 |
| B56 | `holds` is a Map whose values are no longer read, beside `newer` for the same check: one Set of folders taken (daemon/store.ts:128-131, 147, 153, 167) (bert-bae/coplan#89) [re-audit A4 6] | 5 smaller | done: one Set, `taken` | 23495e2 |
| B57 | A store test case pins B46's undated rule, which F38 removed: delete the loop and "nor when it has no time of its own" from its title (store.test.ts:248, 277-289) (bert-bae/coplan#90) [re-audit A4 7] | 5 smaller | done: case and title words removed | a3d107d |
| B58 | An editor opened but not typed in is let go by pruneDrafts at the next snapshot (nothing to lose), so a later lock never tells it (B52): it stays open, disabled, and reopens on stale text with the warning. Call the holders of held fields not kept any more too (ui/lib/drafts.ts:66-69) (bert-bae/coplan#91) [re-audit A4 8] | 5 smaller | done: a lock tells open editors not kept too; holders only while open | 62c3ab0 |
| B59 | A proposal that upserts its new task twice takes the second `parentId` as its place, which applying ignores, so a removal's print misses what is moved under it, and a link the user makes after is lost on accept. Take a new task's place from its first edit (shared/plan.ts:2424) (bert-bae/coplan#92) [re-audit A4 9] | 5 smaller | done: placed by its first edit, afresh after a removal | 426939c |
| B60 | Since B49 a proposed edit may carry `noteWas`, which a direct agent edit refuses: expectAtStart strips it before checkOpFields sees it. Take it off only for the user's edits (shared/plan.ts:1268) (bert-bae/coplan#93) [re-audit A4 10] | 5 smaller | done: taken off for the user's edits only | 876ea82 |
| B61 | Untested new plan code: the 4x bound on the trimmed log, the gap fallback for plan, sections and diagrams, and B50's "note named once" condition each break with every test passing. Add a held section edit to the trimmed test, a note on t3 before the gone case, and a bound assert (shared/plan.ts:155, 1024-1028, 2473) (bert-bae/coplan#94) [re-audit A4 11] | 5 smaller | done: each of the five mutants now fails a test | 2618a48 |
| B62 | Refused inline text (F40) is outside the kept drafts: a lock turns the field read only without unmounting it, so the text goes with no copy offered (and comes back stale if unlocked); closing the page does not ask; F43's copy toast names the field's label only, not the task or the plan. Offer it on a lock, let beforeunload see it, name the item (components/Editable.tsx) (bert-bae/coplan#96) [review of F43] | 5 smaller | done: a lock offers it and closes the field; beforeunload asks; said of its own plan (the toast still names the field by its label) | fa4ed9b |
| B63 | A board card's open comments (F44) and details close when the agent moves it to another column: the card remounts and its local state goes. Keep the open cards in the view by task id (TasksView.tsx TrackedCard) (bert-bae/coplan#98) [review of F44] | 5 smaller | done: kept in the board by task id | cf8cba8 |
| B64 | A saved session with no `updatedAt` never expires: readState's migrate stamps it `Date.now()`, so load's and `legacy()`'s `(updatedAt ?? 0) < cutoff` never see it undated, and an early build's old copy passes the TTL on every start. Decide what undated means and say it in one place (daemon/store.ts:148, 315, 772) (bert-bae/coplan#99) [review of B57] | 5 smaller | done: undated means as old as its file | f5a91f2 |
| B65 | Submit's and Confirm's "would drop" warning does not list a refused inline field: `refusedFields` holds bare tokens, so draftsLockedBy cannot see them; the text is offered only after the lock. Key them by session and field (ui/lib/drafts.ts) (bert-bae/coplan#100) [review of B62] | 5 smaller | done: kept by session, name and the sign-off that locks it | 111080c |
| B66 | A change request being typed on a board card (UserReview's `asking`/`why`) is lost without a word when the agent moves the card: it is drawn anew in its new column. So are keyboard focus and "Show N resolved". Keep the reason as a kept draft, or the card mounted across columns (TasksView.tsx Board, UserReview) (bert-bae/coplan#101) [review of B63] | 5 smaller | done: the reason is a kept draft, by task and round | 1126150 |
| A5 | Re-audit the areas the rows after A4 touched with `/ponytail-audit`, and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing | 6 re-audit | done: no must fix, 4 should fix, 2 nice to have, now rows F48-F51, B67 and A6 | 766a32f |
| F48 | B59 regression: a proposal removing a new task takes only its own id out of `seenNew`/`movedTo`, so a new subtask going with it keeps its old place and the proposal adding it again under another parent is ignored: a link the user makes after to what it moves under it is lost on accept. Take every doomed id out (shared/plan.ts proposalTouches `remove`) (bert-bae/coplan#102) [re-audit A5 1] | 2 should fix | done: every new task a removal takes is placed afresh | 2c2a561 |
| F49 | An existing task a proposal removes and adds again is placed, in its print, where it was, though applying creates it under the new parent: a link the user makes after to what the proposal moves under it is lost on accept. Place an upsert of a removed id by its parentId, as a new task's (shared/plan.ts:2432) (bert-bae/coplan#103) [re-audit A5 2] | 2 should fix | done: the outline follows removals; a task added again is placed by its upsert | 6c4200e |
| F50 | B66 gap: useKeptDraft fixes its key at mount, so a card on screen when its task enters review (or a new round) keeps `review:t3:undefined` (or the old round): pruneDrafts drops the draft at the next snapshot, closing the page stops asking, and a move loses the text. Key UserReview by task and round (TasksView.tsx TrackedCard) (bert-bae/coplan#104) [re-audit A5 3] | 2 should fix | done: UserReview keyed by task and round | d456d06 |
| F51 | F45's 5 s cap cuts a live but slow reader (`coplan check \| less`) without a word and keeps the exit code (0 with an optional failure): 64926 of 200108 bytes reached `(sleep 7; wc -c)`. Fail with a message when output is still pending at the cap, or wait for EPIPE (cli/main.ts:445) (bert-bae/coplan#105) [re-audit A5 4] | 2 should fix | done: no cap; waits as any pipe writer does (a reader that keeps the pipe without reading now holds it) | ab6f03d |
| B67 | Tests: ~~a report over a pipe's buffer reaches a reader in full~~ (done by F51); B64's ensure assertion is vacuous (write the old copy after load); skip `write('')` when nothing is pending, for Windows (project.test.ts, store.test.ts:436, cli/main.ts:446) (bert-bae/coplan#106) [re-audit A5 5, 6] | 5 smaller | done: ensure judges a copy written after load; no empty write with nothing pending | fdf2edb |
| A6 | Re-audit the areas the rows after A5 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#108) | 6 re-audit | done: 2 must fix, 2 should fix, 4 nice to have, now rows F52-F55, B68 and A7 | 3e5350e |
| F52 | F49 regression: a proposal that removes the same id twice (`remove t3, upsert t3, remove t3, upsert t3`) keys both removals' prints `removal:t3`, and the second, worked out from an outline the first already emptied, overwrites the first: a subtask the user adds under t3, a task moved under it, or a link on that task is lost on accept, where 766a32f refused it. Combine the prints under one key (shared/plan.ts proposalTouches `remove`) (bert-bae/coplan#109) [re-audit A6 1] | 1 must fix | done: prints combined under one key (an open proposal of the old build that removes a task twice reads as out of date: refused, not lost) | 871d809 |
| F53 | A cycle in a proposal's working outline crashes: proposal `[move t3 under t2, remove t1]`, then the user moves t1 under t3 (legal in the plan) gives t1→t3→t2→t1, and `descendants` recurses until RangeError in accept_proposal, renderPlan and previewProposal. Skip a move into its own subtree in the outline, and call the proposal out of date (shared/plan.ts proposalTouches `outline`, `descendants`) (bert-bae/coplan#110) [re-audit A6 2] | 1 must fix | done: such a move is out of date (found walking up); descendants stops at a task seen | 7583969 |
| F54 | `ensure` takes an expired session from its own folder (40-day undated file), though `legacy()` refuses the same from an earlier build's folder; and ensure(x) copying y's expired state to y's own folder lets ensure(y) take it. State the keeping rule once for load, legacy() and the own-folder path (daemon/store.ts readSaved) (bert-bae/coplan#111) [re-audit A6 3] | 2 should fix | done: a start deletes what is past keeping; ensure reads it back from either folder and dates it now | 62cc5bd |
| F55 | F50 gap: a change request being typed is dropped without a word when the agent takes the task out of review (to implement, then round 2): pruneDrafts drops it, nothing offers it, closing the page does not ask; before F50 the stale box came back with it. Offer a dropped `review:` draft with text as a locked one is (ui/lib/drafts.ts pruneDrafts, TasksView.tsx UserReview) (bert-bae/coplan#112) [re-audit A6 4] | 2 should fix | done: offered to copy, named by task and round; not while its own send is in flight | d116f46 |
| B68 | An undated state loaded from its own folder is never saved with its date (an mtime bump makes it new again); a task in review with no round keys its draft `review:t3:undefined`, dropped every snapshot; a stray doc comment at store.ts:47; optionally say in exit()'s comment that a reader holding the pipe unread holds the CLI (daemon/store.ts load, TasksView.tsx UserReview, cli/main.ts) (bert-bae/coplan#113) [re-audit A6 5-8] | 5 smaller | done: saved with its file's date at load and ensure; a review with no round is round 1 (normalizeTask); comment gone; exit()'s comment says it | 13d9d49 |
| B69 | A proposed move to a parent the user since removed, or set done or dropped, reads as current (`task:<id>` prints the moved task only) and accept fails with the raw apply error, not "out of date". Print a move's destination, or call an apply error at accept out of date (shared/plan.ts proposalTouches `move_task`) (bert-bae/coplan#115) [review of F53] | 5 smaller | done: moves and new tasks placed by `place`, against the outline; out of date with the reason | c4ba8e3 |
| A7 | Re-audit the areas the rows after A6 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#114) | 6 re-audit | done: no must fix, 3 should fix, 5 nice to have, now rows F56-F58, B70 and A8 | dca5b2b |
| F56 | B68 widened: load saves every undated session (and copies from an old folder) in the constructor, before main.ts listens: a failed save's persist-error goes to no one, and persistFailed then swallows the same failure later, so the user edits a session that never saves, untold. Save after the listeners are on, or record no failure no one heard (daemon/store.ts loadFromDisk, persistNow) (bert-bae/coplan#116) [re-audit A7 1] | 2 should fix | done: held for the first listener (the daemon's log) | cf45a22 |
| F57 | F55 gap: a change request sent as its round stops waiting on the user is refused (409 "not in review"), but pruneDrafts let its draft go unoffered while it was in `sending`: lost (card redrawn) or offered only at a later snapshot, its box hidden. Offer it when save is refused for a key let go while sending; disable Send while saving (ui/lib/drafts.ts pruneDrafts, save; TasksView.tsx UserReview) (bert-bae/coplan#117) [re-audit A7 2] | 2 should fix | done: kept aside while sent, offered on refusal; Send disabled while saving | 3a6f520 |
| F58 | `coplan check` starts the next check after stdout failed (a sync write's error comes a tick later), then exit(1) SIGKILLs it: `check --all >/dev/full` ran check two's side effect. Wait a tick and stop on a failed stdout before each check (cli/check.ts hook loop, cli/main.ts `unwritten`) (bert-bae/coplan#118) [re-audit A7 3] | 2 should fix | done: failure kept in output.ts; check stops before each check; main lets a running command end itself (that part untested: a stdout failing late, not EPIPE, could not be made here) | 90cd05b |
| F59 | A page opened after a save failure was heard (by the daemon's log) is never told: persistFailed says it once per kind, to whoever listens then, so the user edits a session that is not saved. Make a session's save failure part of what a page gets on connect; readSaved's own persist-error skips the dedup (daemon/store.ts persistNow, readSaved; the stream) (bert-bae/coplan#121) [review of F56] | 2 should fix | done: sent with the snapshot on connect (a reconnect says it again: still failing); readSaved's copy deduped, cleared on success | 15eac3c |
| B70 | normalizeTask keeps a stage on a task not in progress (and B68 gives it round 1); an undated session past the cap is not saved with its date at load; the review toast names a removed task by id; exit()'s comment ("as on Windows", ">&-" exits 0 with nothing written); a release note for F52's old double-removal proposals (shared/plan.ts, daemon/store.ts, ui/lib/drafts.ts, cli/main.ts) (bert-bae/coplan#119) [re-audit A7 4-8] | 5 smaller | done: all five. Noted, not done: publish keeps a stage for in_progress only (a blocked task loses it on republish), where edits and load keep it | 77e9506 |
| A8 | Re-audit the areas the rows after A7 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#120) | 6 re-audit | done: 1 must fix, 3 should fix, 4 nice to have, now rows F60-F63, B71 and A9 | d68acb5 |
| F60 | B70 regression: normalizeTask drops the round of a todo task at load, but only the user putting a task back clears rounds and reviews (the agent cannot, by design): after a restart, an agent-todo'd task's next review is round 1 again and roundVerdict finds the old round-1 pass, which meets the done gate unreviewed and resets the round limit. Keep the round at load (shared/plan.ts normalizeTask) (bert-bae/coplan#122) [re-audit A8 1] | 1 must fix | done: load keeps the round; tested through an agent edit and a reload | ac8d31f |
| F61 | A republish drops a kept task's `reviews` (review history gone from the page) and a blocked task's stage (kept for in_progress only, where edits and load keep it for blocked too). Carry `reviews` over; one rule for which statuses keep a stage (shared/plan.ts publishTasks/buildTaskTree) (bert-bae/coplan#123) [re-audit A8 2] | 2 should fix | done: reviews carried with the round; keepsStage shared by publish, edits and load (a publish never runs mid-build, so the blocked case is for consistency); startCommit, own checks, addedInBuild left out on purpose | 520d084 |
| F62 | F57 gap: a review box drawn anew while its request is being sent (task set blocked in review, a tab switch) mounts with Send enabled: a second review_task is sent, and the first save's finally clears the key from `sending` while the second is out. A key being sent is saving (ui/lib/drafts.ts useKeptDraft, TasksView.tsx UserReview) (bert-bae/coplan#124) [re-audit A8 3] | 2 should fix | done: a send's progress and outcome told to every editor of its key (tested on the review box; the reply composer's `sending` wired, not tested) | a39c09b |
| F63 | F58 regression: interactive `coplan setup` with stdout failing (a full disk) no longer ends at once; it waits on prompts no one can see (hung 8 s, killed, no message), and Enter walks it on defaults unseen. Ask nothing once stdout has failed (cli/setup.ts askTerminal) (bert-bae/coplan#125) [re-audit A8 4] | 2 should fix | done: answer() stops the walk once stdout failed (a tick late too); checked by hand under a pty: rc 1 in 0.09 s. --yes still finishes unseen, on purpose | 0866853 |
| B71 | A held persist-error is lost if the first listener added is not an 'event' one, or the first is removed before the next tick; a failed copy's saveFailure outlives the cause for a session later made fresh; normalizeTask keeps an invalid status; Windows may say EOF for a gone reader (unconfirmed) (daemon/store.ts emitEvent, ensure; shared/plan.ts; cli/output.ts) (bert-bae/coplan#126) [re-audit A8 5-8] | 5 smaller | done: held event waits for an 'event' listener; unknown status taken as todo. Not done: clearing the stale copy failure hides a real one (stays until the first save); Windows EOF unconfirmed | 08f7a71 |
| A9 | Re-audit the areas the rows after A8 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#127) | 6 re-audit | done: no must fix, 2 should fix, 3 nice to have, now rows F64, F65, B72 and A10 | ac99e3f |
| F64 | F61 widened: a task reused in the next plan keeps its old build's reviews and round; the agent drops it (ungated before submission), then restarts it after submit, and the old round's pass meets the done gate unreviewed. editTask clears the current round's reviews only on done → not dropped: clear them whenever a task leaves done or dropped for todo, in progress or blocked (shared/plan.ts editTask) (bert-bae/coplan#129) [re-audit A9 1] | 2 should fix | done: the round's pass goes whenever a task leaves done; dropped mid-review keeps its verdicts | 1bfda40 |
| F65 | F62 gap: text typed into an editor drawn anew while its draft is out (its field still takes input while it shows Saving…) is lost when the send goes through: the 'sent' news closes it whatever it holds. Close only if it holds the text sent; else start again from the field (ui/lib/drafts.ts useKeptDraft) (bert-bae/coplan#130) [re-audit A9 2] | 2 should fix | done: 'sent' closes only an editor holding the text sent; the kept draft deleted only if it holds it (on screen or not) | 772ab40 |
| B72 | An interactive setup whose output fails skips the daemon restart (stops at the settings question, after installing; not a regression); a live persist-error just after the first listener can come before held ones; removeAllListeners() strands held events (nothing calls it) (cli/setup.ts setup; daemon/store.ts emitEvent) (bert-bae/coplan#131) [re-audit A9 3-5] | 5 smaller | done: setup ends as --yes once output fails after installing (settings too); held events told in order, kept through removeAllListeners | c7253cc |
| B73 | Reopening a finished task by way of dropped skips the warning that its dependents went ahead on its work (main.ts ~1476 checks done → not done/dropped only) (daemon/main.ts) (bert-bae/coplan#133) [review of F64] | 5 smaller | done: warned when a finished task is no longer done (by its new status, dropped included, by stage alone too); one line per dependent | bf11bd0 |
| A10 | Re-audit the areas the rows after A9 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#132) | 6 re-audit | done: no must fix, 4 should fix, 3 nice to have, now rows F66-F69, B74 and A11 | b42df2b |
| F66 | F64: undoing a mistaken drop of a finished task (done -> dropped -> done, nothing changed) is refused, and the gate's messages loop: give the pass (not in review), go to review (round limit: "what still fails"); a user-reviewed one is told the user has not passed it, not that the pass was cleared. Clear the pass when it leaves dropped for todo, in progress or blocked, not at the drop; say so where a pass was cleared (shared/plan.ts editTask; daemon/main.ts done gate) (bert-bae/coplan#134) [re-audit A10 1] | 2 should fix | done: wasDone marks a drop of a finished task; verdicts go on leaving it for work, kept on undo; never-done drops keep theirs (also B74's board item) | cb6cef2 |
| F67 | B72 regressed B71: the only listener going part way through a flush (once(), or a page's cleanup) leaves the rest held with no wait for the next listener: stranded until another failure. Put the wait back after the loop when some are still held and no listener is left; a listener that throws runs delivery one behind (daemon/store.ts flushSoon) (bert-bae/coplan#135) [re-audit A10 2] | 2 should fix | done: what is still held after a pass goes on (passOnHeld), the wait added once; a throwing listener's own event is gone, as live (untested) | ac5449f |
| F68 | F65 gap: a review box redrawn while its request is out, holding more than was sent: the request goes through, save drops the parked draft, 'sent' restarts the box and re-keeps its draft, but the round is decided so the box is gone: text on no screen, unoffered, closing the page asks; offered later (if ever) as "could not be sent". Offer the extra on 'sent' when the draft was parked (ui/lib/drafts.ts) (bert-bae/coplan#136) [re-audit A10 3] | 2 should fix | done: save offers what a parked draft holds beyond what went ('added'); its boxes close | c533d46 |
| F69 | Older: text typed into an editor while its own save is out is lost when the save goes through (close() regardless); an editor redrawn meanwhile keeps it since F65. Close only if it holds what was sent (ui/lib/drafts.ts save) (bert-bae/coplan#137) [re-audit A10 4] | 2 should fix | done: kept open on what was typed (a reply: only what came after), started from the field; not from the returned revision (an agent edit in that instant is not warned of) | 1489143 |
| B74 | A dropped dependent is told it "no longer" waits; the board's drop then done of a done task loses its round's verdict unnoticed (F66 may cover it); onListener may be registered twice (harmless) (daemon/main.ts, daemon/store.ts) (bert-bae/coplan#138) [re-audit A10 5-7] | 5 smaller | done: dependents() leaves dropped tasks out (reply, brief, page); the other two items by F66 and F67 | 7bd83dc |
| A11 | Re-audit the areas the rows after A10 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#139) | 6 re-audit | done: no must fix, 3 should fix, 8 nice to have, now rows F70-F72, B75 and A12 | f4436c4 |
| F70 | F66's undone half: the done gate's messages loop for a task not in review whose round has no pass (a finished task taken up again; refine; blocked): "verdict pass is fine" (refused: not in review), go to review (round limit: "what still fails"); a user-reviewed one is told "they have not passed it", which the board cannot fix. Point to stage review for a new round, allow it when the pass was cleared, and say the pass was cleared (daemon/main.ts done gate, verdict check) (bert-bae/coplan#140) [re-audit A11 1] | 2 should fix | done: not in review → told to report review for a new round; `reopened` (finished on a pass, taken up again) not held to the round limit | c78e744 |
| F71 | Older (F69 claimed it): an editor off screen when its save goes in keeps the revision from before it (now.current is not updated unmounted): a section reopens with a false "changed while you were editing"; the files' next save is refused for the user's own save. Take the starting point from the plan as it lands, or restart a kept draft from the field on remount (ui/lib/drafts.ts) (bert-bae/coplan#141) [re-audit A11 2] | 2 should fix | done: the kept draft records the saved text and restarts from the field only if it still holds it; a change since is warned of | 033f8d0 |
| F72 | F69 gap: a new comment goes through edit, not the kept draft's save: typed on while posted, it keeps the posted text and posting again repeats it. Post it through comment.save, or drop the sent text from the front (ui/components/Threads.tsx) (bert-bae/coplan#142) [re-audit A11 3] | 2 should fix | done: posted through comment.save; a post returns the composer to open and empty | 16dc3d5 |
| B75 | Tests: wasDone across a republish, B74's done dependent, a comment keeping what came after, a throwing listener; reopening from a drop-while-done gives no "went ahead" warning; a reply or comment edited mid-post is kept whole; the 'added' offer on deleted text; CHANGELOG: comments, B73/B74 (optional) (shared/plan.ts, daemon/main.ts, daemon/store.ts, ui/lib/drafts.ts, CHANGELOG.md) (bert-bae/coplan#143) [re-audit A11 4-11] | 5 smaller | done: two tests, the reopen-from-drop warning (wasFinished), the toast's wording. Not done: a throwing-listener test, mid-post edits kept whole, B73/B74 CHANGELOG | 96754d7 |
| A12 | Re-audit the areas the rows after A11 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#144) | 6 re-audit | done: no must fix, 3 should fix, 4 nice to have, now rows F73-F75, B76 and A13 | 83f037a |
| F73 | F70: passedAndClosed counts any pass in the round, not its standing verdict: pass then "changes" then done on the user's word, taken up again, escapes the round limit (self and user review). Use roundVerdict with the effective review mode; in skip mode a round closed done counts as passed (shared/plan.ts passedAndClosed) (bert-bae/coplan#145) [re-audit A12 1] | 2 should fix | done: the round's standing verdict under its review mode (skip: closed done passes); the daemon passes its own setting | 5960091 |
| F74 | F70: a drop clears `reopened`, so done (pass) -> taken up -> dropped -> taken up -> review is refused at the limit though no round failed (its pass went at the first take-up). Keep it through a drop; clear on review, done, the user's reset; test that later rounds are held to the limit (shared/plan.ts editTask) (bert-bae/coplan#146) [re-audit A12 2, 5] | 2 should fix | done: kept through a drop; goes on done, review (tested), the user's reset; load drops it from a done task | ac522a5 |
| F75 | F71: the remount check compares the field with the untrimmed sent text, but the daemon trims fields: a section saved as "First.\n" off screen reopens warning of the user's own save (summary, captions, notes too). Compare trimmed (ui/lib/drafts.ts) (bert-bae/coplan#147) [re-audit A12 3] | 2 should fix | done: compared trimmed (a field cut at 20,000 characters is not) | 0863a74 |
| B76 | A stale `reopened` from an older daemon is trusted; done for a task in refine/blocked after "changes" at the limit points to review, then refused; a section cleared mid-save off screen stays kept empty; untested: drafts.ts's blank guard, brief.ts's !t.reopened (shared/plan.ts, daemon/main.ts, ui/lib/drafts.ts, daemon/brief.ts) (bert-bae/coplan#148) [re-audit A12 4, 6-8] | 5 smaller | done: all four (a field emptied on purpose mid-save is taken as nothing to keep) | 4748d92 |
| A13 | Re-audit the areas the rows after A12 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#149) | 6 re-audit | done: no must fix, 3 should fix, 6 nice to have, now rows F76-F78, B77 and A14 | 6e5f565 |
| F76 | F73: without a submission, editTask judges the round under DEFAULT 'self', the daemon under the project's review: in an unsubmitted Managed build a user-reviewed task closed on the user's word gets `reopened` (round 2 of 1, unapproved), a skip-mode one does not (refused). Pass the effective review fallback into applyOps/editTask, and to review_task's record (shared/plan.ts; daemon/main.ts) (bert-bae/coplan#150) [re-audit A13 1] | 2 should fix | open | |
| F77 | Older: a reply box drawn anew while its reply posts, typed on, keeps the whole text when the post goes in (on screen or off): posting again repeats the first part. Apply the sender's rule in the watcher and the kept draft: drop the sent text from the front for replies/comments; close on the sent text trimmed or blanks (ui/lib/drafts.ts) (bert-bae/coplan#151) [re-audit A13 2, 4] | 2 should fix | open | |
| F78 | B76's done-gate message does not say another round is stage "review" with user_approved, and words it unlike the round-limit gate; its comment sits above the wrong branch; F73's test passes with the mode ignored (add user "changes" then agent pass); B76's whitespace case untested (daemon/main.ts, test/plan.test.ts, ui/lib/drafts.ts) (bert-bae/coplan#152) [re-audit A13 3, 5, 6] | 2 should fix | open | |
| B77 | Skip mode puts no real limit on rounds (document or decide); a local `reopened` in main.ts means something else; ReviewMode import order (daemon/main.ts, shared/plan.ts) (bert-bae/coplan#153) [re-audit A13 7-9] | 5 smaller | open | |
| A14 | Re-audit the areas the rows after A13 touched with four auditors (plan model, check runner, store, page), and add any new findings as rows. The loop ends when a re-audit finds only Nice-to-have or nothing (bert-bae/coplan#154) | 6 re-audit | open | |

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

- **D2 (F30, asked in bert-bae/coplan#81):** The agent's `move_task` is not checked against the user's
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
- **D3 (B38, asked in bert-bae/coplan#82):** A check that exits on its own while something it started
  is still running in its process group (a test runner's stray worker, a
  server started with `&`, its output redirected) is over at once, and that
  process runs on beside the next check, and past `coplan check`. Options:
  - **Stop the rest of its group when it exits**, as a timeout does
    (SIGTERM, then SIGKILL three seconds on): nothing a check starts
    outlives it. Cost: a check that starts a server for the checks after it
    (`npm run dev &`) has it stopped; it must start it in a group of its own
    (`setsid`), or the checks be one.
  - **Leave it running.** As now, though, one that writes to the check's
    output (not redirected: `npm run serve & npm run e2e`) holds the check
    until its timeout, which fails it as timed out. Leaving it running
    means letting the check go on its shell's exit instead, not waiting
    for its group (found in re-audit A2); stopping the group fixes that too.

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

## Re-audit report (row A2, ponytail-audit, 2026-11-10)

Scope: the changes since f6e0648 (row A1) in `src`, `bin` and `hooks`, and
what they touch. Read by four auditors, one per area (check runner and MCP,
daemon store, plan model, page); every finding below was reproduced, and
the reproductions were run again before being kept.

**What this repo does:** Coplan lets a developer and a coding agent plan a
change together. A local daemon keeps each session's plan; the agent edits
it through an MCP server, the user in a browser page, and a CLI runs the
repository's checks. Load assumed: one developer on one machine, a few
agent sessions, plans up to a few MB.

### Should fix

1. **A proposal checks its edits' revisions as if the user made them** (`shared/plan.ts:1649-1653, 2183, 2987-2993`)
   - **What this is:** an edit can carry `expect`, the revision it was made on. A task edit is refused when the *other* side changed the task since.
   - **Problem:** a proposal's edits are tried as the user's, so they are compared with the agent's changes, not the user's. The user edits t3; the agent, having read before that, proposes t3's old text with `expect: 1`. Sent directly it is refused; proposed, it is accepted, and accepting it overwrites the user's text.
   - **Fix:** check each inner `expect` as Claude's when the proposal is made, then try the edits without it.
   - **If we skip it:** a proposal can quietly carry the agent's stale text over the user's.
2. **A proposal ignores its own earlier edits** (`shared/plan.ts:1278-1280, 2222-2304`)
   - **What this is:** a batch of edits is checked as its earlier edits leave the plan; so is what makes a proposal out of date, for one edit.
   - **Problem:** a proposal is checked edit by edit against the plan before it. `[move t3 under t1, remove t1]` passes though the user's unread change to t3 would be refused in a batch; and when the user then links a box or a dependency to t3, the proposal stays acceptable, and accepting it drops them.
   - **Fix:** guard each inner edit on the trial copy, as a batch is; print a `move_task` with what removing the moved task would take.
   - **If we skip it:** the guard the batch has can be gone round in a proposal.
3. **The user's old status note saves over the agent's newer one** (`shared/plan.ts:1823-1828, 1906-1910`)
   - **What this is:** the agent reports progress with a note and a status. The note editor saves with the task's revision.
   - **Problem:** the progress note changes `task.note` without moving the revision. The user's note editor, opened before the agent wrote "Blocked: DB creds missing", saves over it with no conflict.
   - **Fix:** move the revision when the note changes.
   - **If we skip it:** the agent's blocker report can vanish.
4. **An unsent comment outlives Submit and can never be sent** (`ui/lib/drafts.ts:87-90`)
   - **What this is:** kept drafts that the plan's lock would hold still make Submit wait, and a lock from chat toasts them with a Copy button.
   - **Problem:** comment and reply drafts are never taken as locked, though a submitted plan refuses the user's comments. Submit goes ahead, the comment box goes, no toast says so, and the page asks before closing until it is reloaded.
   - **Fix:** take comment and reply drafts as locked once the plan is, and name them.
   - **If we skip it:** a comment the user wrote is lost unsaid.
5. **A reply being typed vanishes when its thread is resolved** (`ui/lib/drafts.ts:89-90`, `components/Threads.tsx:66-75`)
   - **What this is:** a reply being written is kept while its thread is open.
   - **Problem:** when the agent resolves the thread, the draft is dropped and the thread moves to the hidden resolved list, with no toast, though a resolved thread still takes replies.
   - **Fix:** keep a reply while its thread exists.
   - **If we skip it:** the user's half-written reply is gone.
6. **Ctrl+C crashes `coplan check` when nothing reads its errors** (`cli/check.ts:312`)
   - **What this is:** on Ctrl+C the command says it is stopping the check, then waits for it and kills what ignores the stop.
   - **Problem:** it says so with `process.stderr.write`. Under `2>&1 | head`, or an agent that closed the pipe, that write fails (EPIPE) and crashes the command after the SIGTERM but before the wait and the kill: a worker that ignores SIGTERM runs on.
   - **Fix:** `console.error`, which ignores write errors.
   - **If we skip it:** row B31's fix is undone exactly when an agent ends the command.
7. **Three guards against losing a session's plan have no test** (`daemon/store.ts:197, 303, 315`)
   - **What this is:** the code that reads and removes folders an earlier build named.
   - **Problem:** each guard can be deleted with every store and integration test still passing. Without them, deleting `a:b` deletes session `a_b`'s plan, an old copy goes over a session's newer one, or `a:b` is served `a_b`'s plan.
   - **Fix:** one store test each.
   - **If we skip it:** a later change can bring back B22's data loss unseen.

### Nice to have

8. **Every removal copies the whole plan** (`shared/plan.ts:2000`): only to describe the comments it orphans; 40 removals on a 5.4 MB plan hold the daemon about 0.9 s. A shallow copy does.
9. **A diagram conflict blames "another edit"** (`shared/plan.ts:760-764, 2938`): a link change of the agent's keeps the last design editor as `updatedBy`; `bumpDiagram` should take the author.
10. **A check that ended in time can be reported as timed out** (`cli/check.ts:290-299`): when its timeout falls in the 200 ms let-go. Clear the timer once it has ended.
11. **A hook whose folder is a file crashes `coplan check`** (`cli/check.ts:191`): `spawn` throws ENOTDIR; ask for a directory.
12. **Clicking Reply again empties the reply** (`components/Threads.tsx:100`): leave an open editor as it is.
13. **A section comment is stuck once the design is confirmed** (`views/OverviewView.tsx:40`): its box is inside the summary's disabled fieldset; move it out.
14. **The Copy toast's staying up is untested** (`ui/store.ts:796`).
15. **An earlier build run again gets the stale old folder** (`daemon/store.ts:149-162, 276, 313-316`): remove the old folder once a session has moved, when it is the session's.
16. **Ids with lone surrogates share a folder** (`shared/paths.ts:41`): hash the id as `utf16le`.

Also found, and folded into decision D3 rather than a row: a check that
leaves a process running in its group that writes to the check's output
runs to its timeout and fails as timed out.

Checked and not a finding: `coplan clean sessions` with no daemon running
removes every session untouched for a day; that is the group's documented
rule, as it is for sessions a long-running daemon has let go from memory.

**Verdict:** no Must fix. Fix 6 first (it undoes B31 when an agent ends a
check), then the proposal guards (1, 2) and the lost text (3, 4, 5).

**Not checked:** a real browser (clipboard, focus order), two tabs at once,
Windows, macOS's `/bin/sh` for the relay, case-insensitive filesystems
(ids that differ only in case), and what agent harnesses do on a timeout.

## Re-audit report (row A3, ponytail-audit, 2026-11-10)

Scope: the changes since fb5c76d (row A2), by four auditors as before
(plan model, check runner, store, page); each finding kept was run again.

**What this repo does:** as in the A2 report. Load assumed: one developer,
a few agent sessions, plans up to a few MB.

### Should fix

1. **B46's newest-copy rule loses work** (`daemon/store.ts:168-176, 320-330`). Taking whichever folder's copy of a session is newest by its time lets a tie (decided by readdir order), a hook's fresh stamp on an earlier build's stale copy, or a clock running ahead put an old copy over the session's own, and the own copy is not kept anywhere. Reproduced: a session's folder reverting at the second start; an hour of work gone from disk. Go back to the own folder winning once it holds a readable copy.
2. **Closing the terminal crashes `coplan check` before its check is stopped** (`cli/main.ts:422`). SIGHUP, then EIO on the interrupt message, which F36's EPIPE-only guard rethrows. Let every write error on stdout and stderr go.
3. **A save refused as changed underneath is saved on the next blur** (`components/Editable.tsx:83-91, 109`). The refusal reopens the field on the new base, so a click anywhere saves the user's text over what the refusal was about. Leave it by Enter or Escape only.
4. **A trimmed change log hides unread edits from the guard** (`shared/plan.ts:148, 1001-1006`). Older than this loop: after 500 other changes, the agent's edit and progress note go over the user's unread ones. Compare the whole baseline when the log has a gap.

### Nice to have

5. A proposed removal's print misses a task moved under one the proposal adds (`plan.ts:2341`).
6. A proposal's `expect` is checked mid-batch, after the batch's own direct edits (`plan.ts:1728`).
7. A proposal's staleness ignores a task's note (`plan.ts:2324`).
8. A submitted plan offers a section's comment button onto an empty panel (`OverviewView.tsx:156`).
9. A comment a lock dropped comes back untracked on reopen (`Threads.tsx:60`).
10. A hook folder without search permission is reported as `spawn sh EACCES` (`check.ts:194`).

**Verdict:** no Must fix; fix 1 first (it can lose a plan), then 2 and 3.

**Not checked:** a real browser's focus after a refusal, two tabs, Windows and
macOS, case-insensitive filesystems, an agent harness that SIGKILLs the
whole group.

## Re-audit report (row A4, ponytail-audit, 2026-11-10)

Scope: the changes since 30f7435 (row A3), by four auditors as before
(plan model, check runner, store, page); each Should fix was run again.

**What this repo does:** as in the A2 report. Load assumed: one developer,
a few agent sessions, plans up to a few MB.

### Should fix

1. **Ctrl+C with stderr on a full disk crashes `coplan check` before the stop** (`cli/main.ts:421-425`). The interrupt message fails with ENOSPC, which F39's EPIPE/EIO guard rethrows; the worker that ignores SIGTERM runs on. Reproduced with `2>/dev/full`: the CLI gone, `sleep 30` still running. Let stderr ignore every write error.
2. **Refused text is lost when its field goes** (`components/Editable.tsx:119, 135-143`). After F40, a field holding a refused save is left by unmounting it (a tab or session switch, Details closed) with nothing kept and nothing said. Offer it to copy.
3. **A submitted plan's task comments cannot be read** (`views/TasksView.tsx:59, 562, 1105`). The locked Tasks tab is the board, whose cards show none, nor the agent's replies. B51's TaskRow guard never runs there, and its test's task assertion is vacuous.
4. **No test holds the newer-build guard in load** (`daemon/store.ts:167`). Removing `newer.has(own)` passes all 31 store tests (run again); it would write an old copy over a newer build's plan on a downgrade.

### Nice to have

5. Load's `sessions.has` before persistNow does nothing (`store.ts:175`).
6. `holds` is a Map whose values go unread, beside `newer` (`store.ts:128`).
7. A store test case pins B46's removed undated rule (`store.test.ts:248`).
8. An editor opened but not typed in can miss B52's lock reset (`drafts.ts:66`).
9. A proposal upserting its new task twice is placed by the ignored second `parentId` (`plan.ts:2424`).
10. A proposed edit may carry `noteWas`, which a direct agent edit refuses (`plan.ts:1268`).
11. Untested: the log's 4x bound, the gap fallback beyond tasks, B50's note condition (`plan.ts:155, 1024, 2473`).

Checked and fine: F38's own-folder rule and its guards (mutants), F39 under a
real pty, B53 as `nobody` (CI is not root, so its test runs there), F41's
trimming and gap fallback, B48-B50 and B54's prints, B52's holders across
sessions and in-flight saves.

**Verdict:** no Must fix; fix 3 first (the agent's answers are hidden through
the build), then 2, 1 and 4.

**Not checked:** a real browser's blur and focus, macOS and Windows, network
filesystems' ENOSPC/EDQUOT, readdir orders other than sorted, render.ts's
summary past 2000 unread changes.

## Re-audit report (row A5, four auditors, 2026-11-11)

Scope: the changes since 8c30940 (the A4 work, squashed into main), by four
auditors (plan model, check runner, store, page); each finding kept was
reproduced.

### Should fix

1. **B59 forgets a removed new task's subtasks** (`shared/plan.ts` proposalTouches `remove`). A new subtask that goes with a removed new task keeps its old place, so the proposal adding it again elsewhere is printed wrongly and a user's later link is lost on accept. Reproduced; 8c30940 refused it.
2. **A removed task added again keeps its old place in the print** (`plan.ts:2432`). Older; same effect.
3. **B66 misses a card that enters review on screen** (`TasksView.tsx` UserReview): the kept draft's key is fixed at mount, so the request is dropped at the next snapshot. Reproduced in jsdom.
4. **F45's 5 s cap cuts a slow reader silently** (`cli/main.ts:445`): `| (sleep 7; wc -c)` got 64926 of 200108 bytes, exit 0.

### Nice to have

5. No test that a report over 64 KB reaches a pipe reader in full; skip `write('')` with nothing pending.
6. B64's ensure assertion checks nothing (load already deleted the folder).

Not new, noted only: a session reached only by read-only calls is never re-dated, so it can expire while in use (as before B64 for dated files).

Checked and fine: B60 (agent's noteWas refused, user's checked), B61's tests,
T7/B55/B56/B57 and B64's expiry and migration (scratch tests), F43/B62/B65's
refused text (offered once, beforeunload cleared, named by sign-off), B58's
holders loop, F44/F47/B63 comments and open cards, F45 on a full disk, EPIPE,
signals and long-running commands.

**Verdict:** no Must fix; fix 1 first (it can lose a user's link), then 3, 4, 2.

## Re-audit report (row A6, four auditors, 2026-11-11)

Scope: the changes since 766a32f (rows F48-F51 and B67), by four auditors
(plan model, check runner, store, page), each in its own worktree; each
finding kept was reproduced with a scratch test or command.

### Must fix

1. **A second removal of the same id overwrites the first's print** (`shared/plan.ts` proposalTouches `remove`). `[remove t3, upsert t3, remove t3, upsert t3]`, then the user adds a subtask under t3, moves t4 under it, or links t4 and moves it: accept goes through and the user's edit is lost. 766a32f refused all three. F49 regression.
2. **A cyclic working outline crashes** (`plan.ts` `descendants`). `[move t3 under t2, remove t1]`, then the user moves t1 under t3: RangeError in accept_proposal, renderPlan and previewProposal. Predates F48/F49.

### Should fix

3. **`ensure` takes an expired session from its own folder** (`daemon/store.ts` readSaved), though not from an earlier build's folder. Predates B64.
4. **A change request being typed is dropped when the task leaves review** (`TasksView.tsx` UserReview, `drafts.ts` pruneDrafts): not offered, not asked about on close. Follows from F50.

### Nice to have

5. An undated own-folder state is never saved with its date.
6. A task in review with no round: draft key `review:t3:undefined`, dropped each snapshot.
7. A stray doc comment at `store.ts:47`.
8. `exit()`'s comment could say a reader holding the pipe unread holds the CLI (F51's accepted trade-off; no internal caller pipes the CLI without reading).

Checked and fine: a fuzz of ~4,700 proposals against ~70 user edits each
(nothing else lost or wrongly refused); F48's and F49's named sequences
against applyOps; exit() with a slow reader (200056 of 200056 bytes, exit
1), an early-closing reader, stdout closed, /dev/full (ENOSPC, exit 1), a
TTY, SIGTERM/SIGINT/SIGHUP while blocked, and the order of the error event
and leave; B67's empty-write skip (same results); dating by file on every
read path; the copy-to-own-folder write keeps the old date; failed saves
keep the old mtime; UserReview's remount keeps the draft across a column
move and beforeunload still asks.

**Verdict:** 2 Must fix. Fix 1 first (it loses a user's edit silently),
then 2, 4, 3.

## Re-audit report (row A7, four auditors, 2026-11-11)

Scope: the changes since 28e7a26 (rows F52-F55, B68, B69), at e81dc2d, by
four auditors (plan model, check runner, store, page), each in its own
worktree checked out at that commit; each finding kept was reproduced,
except where marked.

### Should fix

1. **A save failing at daemon start is told to no one** (`daemon/store.ts` loadFromDisk): it runs before main.ts listens, and persistFailed then swallows the same failure later. Wider since B68.
2. **A change request sent as its round stops waiting is lost** (`ui/lib/drafts.ts`): refused by the daemon, and let go unoffered while it was being sent. F55 gap.
3. **`coplan check` starts the next check after its output failed, then kills it** (`cli/check.ts`). Older.

### Nice to have

4. normalizeTask keeps a stage on a task not in progress (and B68 gives it round 1).
5. An undated session past the cap is not saved with its date at load.
6. The review toast names a removed task by id (not reproduced).
7. exit()'s comment: "as on Windows"; `>&-` exits 0 with nothing written.
8. F52 reads an old proposal that removes a task twice as out of date (not run): a release note.

Checked and fine: a fuzz of ~25,000 proposals with 1-5 user edits each (no
crash, no false out-of-date, none judged current that then failed, no user
edit lost); `place`'s closed check against applyOps' (reorders, earlier
moves, re-added tasks); sentinels against fingerprints; B68's round against
the pile and later reviews; ensure's revival kept at the next start, the
copy branch, WeakSet identity through migrate, the rail's order; F55's
offer once, session switches, boot, two tabs, the own send landing first,
save()'s try/finally; exit() on pipes, slow and early-closing readers,
/dev/full, a TTY, and signals.

**Verdict:** no Must fix; fix 2 first (it loses what the user typed), then
1, 3.

## Re-audit report (row A8, four auditors, 2026-11-11)

Scope: the changes since 137b984 (rows F56-F59, B70), at 34d17d3, by four
auditors (plan model, check runner, store and stream, page), each in its
own worktree at that commit; each finding kept was reproduced, except
where marked.

### Must fix

1. **A restart clears an agent-todo'd task's round** (`shared/plan.ts` normalizeTask, B70): its next review is round 1 again, and the old round-1 pass gets it past the done gate unreviewed.

### Should fix

2. **A republish drops review history and a blocked task's stage** (`plan.ts` publishTasks). Older.
3. **A review box drawn anew mid-send can send again** (`ui/lib/drafts.ts`, `TasksView.tsx`). F57 gap.
4. **Interactive `setup` with stdout failing waits on unseen prompts** (`cli/setup.ts`). F58 regression.

### Nice to have

5. A held persist-error lost if a listener of another name comes first, or the first is removed before the next tick (not so today).
6. A failed copy's saveFailure outlives its cause for a session later made fresh.
7. normalizeTask keeps an invalid status.
8. Windows may report EOF, not EPIPE, for a gone reader (not reproduced).

Checked and fine: every CLI command to /dev/full (rc 1, said once),
exit() twice, check with --json, --list, zero hooks, a disk filling
partway, `| head -c1`, `>&-`, a slow reader, a TTY, SIGINT; held events
reach the log once and in order; the stream sends only the focused
session's failure; persistFailed cleared on save, drop, purge and a good
copy; B70's write-back as nobody (read-only, newer build, old copy; 12 ms
for 65 sessions); F57's refused send offered once (card in place, moved,
session switched), own request first, throws, other editors untouched;
blocked keeps its stage, done/dropped keep round and reviews; proposals'
prints unchanged across a reload.

**Verdict:** 1 Must fix; fix 1 first, then 4, 3, 2.

## Re-audit report (row A9, four auditors, 2026-11-11)

Scope: the changes since 712303e (rows F60-F63, B71), at 95ad9d2 (merged
as #128), by four auditors (plan model, setup/CLI, store, page), each in
its own worktree at that commit; each finding kept was reproduced. The
page auditor stopped at a usage limit and was resumed after it reset.

### Should fix

1. **A task reused in the next plan passes the done gate on its old review** (`shared/plan.ts` editTask, with F61's carried reviews): done, then dropped, then restarted keeps the old round's pass.
2. **Text typed into an editor drawn anew while its draft is out is lost on 'sent'** (`ui/lib/drafts.ts`). F62 gap.

### Nice to have

3. An interactive setup whose output fails skips the daemon restart (not a regression).
4. A live persist-error just after the first listener can come before held ones.
5. removeAllListeners() strands held events (nothing calls it).

Checked and fine: keepsStage matches the old deny-list for all five
statuses; status coercion changes no plan current code writes; load ->
publish -> load is byte-identical; setup on a healthy pty (a full walk,
Ctrl+C and Ctrl+D 130), the first write being the question (rc 1 in 0.08
s), uninstall and --yes to /dev/full; askTerminal the only prompt in the
CLI; held events with a listener removed before the tick, once(), two
listeners, real startup order; the persist-error path end to end;
F62's watchers across the summary, replies and the review box (sender
unmounted, refused, sent), no two editors of one key open at once,
F57's offer still once.

**Verdict:** no Must fix; fix 1 first (it passes the review gate), then 2.

## Re-audit report (row A10, four auditors, 2026-11-11)

Scope: the changes since 323294e (rows F64, F65, B72, B73), at 90f01e5,
by four auditors (plan model and task route, setup/CLI, store events,
page), each in its own worktree at that commit; each finding kept was
reproduced, except where marked.

### Should fix

1. **Undoing a mistaken drop of a finished task is refused, its messages looping** (`shared/plan.ts` editTask, `daemon/main.ts` done gate). From F64.
2. **Held save failures stranded if the only listener goes part way through** (`daemon/store.ts` flushSoon). B72 regressed B71; not reached by the daemon today.
3. **A review box redrawn mid-send, holding more than was sent, hides it once the request goes through** (`ui/lib/drafts.ts`). F65 gap.
4. **Text typed into an editor during its own save is lost** (`ui/lib/drafts.ts` save). Older (not reproduced for replies and the review box).

### Nice to have

5. A dropped dependent told it "no longer" waits.
6. The board's drop then done of a done task loses its round's verdict.
7. onListener can be registered twice (harmless).

Checked and fine: setup on a pty (healthy walk, Ctrl+C/D 130, stdout
failing at chosen points on a small tmpfs: settings files whole or not
written, the daemon restarted, rc 1), --uninstall; a listener raising a
failure while told one; removeAllListeners with a removeListener
listener; snapshots unaffected by held failures; done set again on a
done task changes nothing; mixed dependents named once; a stage-only
reopen warns; a versioned section redrawn mid-save takes the new
revision (no false warning); trimming; comments unaffected.

**Verdict:** no Must fix; fix 1 and 3 first (they refuse or hide the
user's work), then 4, 2.

## Re-audit report (row A11, four auditors, 2026-11-11)

Scope: the changes since a13d287 (rows F66-F69, B74), at f6de757, by four
auditors (plan model, whole branch and checks, store events, page), each
in its own worktree at that commit; each finding kept was reproduced,
except where marked.

### Should fix

1. **The done gate's messages loop for a task not in review whose round has no pass** (`daemon/main.ts`). F66's undone half.
2. **An editor off screen when its save goes in keeps a stale starting point** (`ui/lib/drafts.ts`). Older; F69 claimed it.
3. **A new comment typed on while posted repeats its first part when posted again** (`ui/components/Threads.tsx`). F69 gap.

### Nice to have

4-7. Tests for wasDone across a republish, B74's done dependent, a comment's kept rest, a throwing listener.
8. Reopening from a drop-while-done gives no "went ahead" warning.
9. A reply edited mid-post is kept whole.
10. The 'added' offer on deleted text (not reproduced).
11. CHANGELOG: comments; B73/B74 (optional).

Checked and fine: check implement, review (twice) and final pass; the
runtime suite on Node 20.11.0 (688 pass); ui.test six times at once, no
flake; every fix since #128 pinned by a test that fails when it is
reverted; the CHANGELOG entries match the code; a drop undone keeps its
pass (user-reviewed too); taking work up again clears it; wasDone on
reload, republish and the user's own edits; dependents() callers (no
readiness change); held events with once(), listeners added or removed
mid-flush, re-entrant failures, flushPending; restart points on screen;
the 'added' offer once, not on blanks.

**Verdict:** no Must fix; fix 1 first (it can stall a build), then 3, 2.

## Re-audit report (row A12, four auditors, 2026-11-12)

Scope: the changes since b0647d1 (rows F70-F72, B75), at 8e8f2b5, by four
auditors (plan model and gates, whole branch and checks, store, page),
each in its own worktree at that commit; each finding kept was reproduced,
except where marked.

### Should fix

1. **A round that ended in "changes" escapes the round limit when taken up again** (`shared/plan.ts` passedAndClosed). From F70.
2. **A reopened task dropped and taken up again is stopped at the limit** (`shared/plan.ts` editTask), found by two auditors; and nothing tests that later rounds are held. From F70.
3. **A field saved off screen reopens with a false warning when the daemon trimmed it** (`ui/lib/drafts.ts`). From F71.

### Nice to have

4. A stale `reopened` from an older daemon is trusted (not reproduced end to end).
5. (with 2) the clear on entering review has no test.
6. Done for a task in refine/blocked at the limit points to review, then refused.
7. A section cleared mid-save off screen stays kept empty.
8. Untested: drafts.ts's blank guard, brief.ts's !t.reopened.

Checked and fine: check implement, review (twice), final; the Node 20.11.0
runtime suite twice (690 pass); every test added since A11 pins its fix
(each reverted); no flake; the CHANGELOG matches the code (but for 2);
wasDone/reopened do not touch proposal prints, change baselines, rendered
or exported plans, or the page; save/reload round-trips byte-identical;
older builds load the fields; STATE_SCHEMA stays (bumping would blank
this build's files for older daemons); held save failures at startup; the
user-reviewed reopen path; the comment composer (typed on, cleared,
second post, refused, lock); replies off screen.

**Verdict:** no Must fix; fix 1 first (it lets the agent past the user's
round limit), then 2, 3.

## Re-audit report (row A13, four auditors, 2026-11-12)

Scope: the changes since af1c662 (rows F73-F75, B76), at a4c471e, by four
auditors (plan model and gates, whole branch and checks, store, page),
each in its own worktree at that commit; each finding kept was
reproduced, except where marked. Two auditors stopped at a usage limit
and were resumed after it reset.

### Should fix

1. **An unsubmitted Managed build judges the round under the default review mode** (`shared/plan.ts` editTask): a user-reviewed task closed on the user's word gets past the limit; a skip-mode one is held.
2. **A reply box drawn anew mid-post keeps the whole text** (`ui/lib/drafts.ts`): posting again repeats the first part. Older.
3. **B76's done-gate message is unclear** (`daemon/main.ts`), and F73's user-review case and B76's whitespace case are not pinned by tests.

### Nice to have

4. The watcher matches the sent text exactly (a redrawn box with a newline or cleared stays open).
5-6. (with 3) the misplaced comment; the whitespace test.
7. Skip mode puts no real limit on rounds.
8. A local `reopened` in main.ts means something else.
9. ReviewMode import order.

Checked and fine: check implement, review (twice), final; the Node
20.11.0 runtime suite (693 pass); UI tests five times in a row and six at
once, no flake; every fix since A12 pinned (each reverted); the CHANGELOG
matches the code; no dead code or unused exports; submitted builds under
self, user and skip review: the free round given and held as intended,
every done-gate message points to an accepted action; save/reload
round-trips byte-identical, an older build's stale flags dropped on
load with no spurious change, revision or unread; text differing inside
is kept, the remount comparison sound (the daemon trims every field).

**Verdict:** no Must fix; fix 1 first (it can pass the user's round
limit), then 2, 3.
