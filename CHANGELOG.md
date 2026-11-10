# Changelog

## Unreleased

### Fixes

- **On macOS, hooks start the daemon again.** The hook relay started it
  with `setsid`, which macOS does not have, and its fallback could never
  run. So a new session waited five seconds for nothing, and after the
  daemon's idle shutdown, a plan you signed off could miss your next
  message. The relay now has node start it, detached, everywhere.
- **A tool call the daemon fails is an error to the agent.** A daemon
  error, a request too large or malformed JSON reached the agent as a
  successful result, carrying raw JSON, so it carried on as though, say, a
  publish had been stored. It now gets an error, in the daemon's words.
- **`coplan stop` and `coplan restart` stop a hung daemon.** A daemon
  stuck too hard to run its shutdown kept running while `stop` said
  "stopped", and `restart` waited on it for ever. `stop` now kills one
  that has not gone within three seconds, and says so; `restart` gives up
  asking it after five seconds and stops it.
- **The agent cannot undo an edit of yours it has not read, by the side
  door.** Its edits were checked only against the one item they named.
  Setting a task's `builds` could drop a box link you had just made, and
  removing a task took the subtasks, dependencies and links you had just
  changed with it, after which the read-back said your edits "cancel
  out". Both are now refused until it reads the plan, like any other
  edit over yours.
- **What you do after submitting reaches the agent.** Handing it the build
  prompt counted as its read of the whole plan, so a proposal you rejected
  after submitting, with your reason, or a task's checks you changed then,
  never showed in its read-back. Those now stay unread and it is told to
  read them, as when it is handed the confirmed design.
- **What you type in a box's panel is no longer wiped by the agent.** A
  change the agent published to the box you were typing in replaced your
  text while you were still in the field, and nothing was saved. The
  label, detail and description fields now keep what you type while you
  are in them, and say when the box changed meanwhile: leaving keeps your
  text, Esc takes the new one. Out of the field they follow the plan.
- **The summary, a box's notes and a diagram caption warn you too.** If
  the agent changed one while you were editing it, saving replaced its
  text with yours without a word. You now see "This changed while you
  were editing" first, as tasks and sections already showed; saving still
  goes in, as the choice is yours.
- **A sign-off is not lost when the daemon is slow to answer.** If the
  daemon was too busy to answer your message's hook before the hook gave
  up, it still marked the plan or design you signed off as delivered,
  though the agent never got it, and nothing sent it again. The hook now
  says when it gives up; a daemon that answers later keeps the prompt for
  your next message.
- **Accepting a proposal cannot undo what you changed after it was made.**
  A proposal is out of date once you change what it would change, but
  only the item each edit named was compared: accepting a proposed task
  removal took subtasks, dependencies and box links you had changed since
  with it, and a proposed `builds`, box edit or box removal undid task
  links you had made. These now read as out of date and say what changed;
  one made before this version reads as out of date too, as it cannot be
  checked in full.
- **`coplan init` writes checks that run your scripts.** It wrote a
  script as `<package manager> <script>`, which for some names is the
  package manager's own command: `yarn check` (yarn's integrity check,
  which passes without running anything), `bun test` (Bun's test runner)
  and `pnpm ci` (which fails). It now writes `<package manager> run
  <script>` throughout. A `.coplan/config.json` it wrote before keeps its
  commands: look for those three and add `run`.
- **A field you are typing in is saved to its own plan when you switch
  sessions.** Going to another session (Back, say) while typing a task's
  title, note or branch dropped what you typed, or, in a browser that
  blurs a field as it goes, could save it into the session you switched
  to, where the same task id is another task. It is now saved where you
  typed it, before the switch.
- **A Codex thread whose hooks are not trusted yet no longer takes another
  repository's settings.** Seen first through a tool call, which names no
  folder, its session was given the daemon's own: the repository of
  whichever session started it, with that repository's checks, base branch
  and git. It now has no folder until a hook says which, and no checks or
  git are guessed meanwhile.
- **A session with a plan stays in the list.** The daemon keeps 60
  sessions in memory, chosen by the last activity alone, and every agent
  session counts, plain ones included. Sixty newer sessions that never
  used Coplan pushed an open plan out of the browser's list and out of
  `coplan open` until its agent was used again. Sessions you planned in
  and the rest are now kept apart, the newest 60 of each, so neither can
  push out the other.
- **Finished work stays finished when tasks move.** Adding a subtask to a
  task already started or done was refused, but moving one under it, or a
  republish nesting new work under it, was not: the task became a parent,
  read as ready again, and its finished work dropped out of the counts.
  All three are now refused the same way, with what to do instead, and
  the task list no longer offers nesting or dropping a task into one.
- **A dependency settled by dropping its work no longer reads as not
  done.** The board counted dropped work as settled and showed the task
  ready, but its brief (and the exported plan's) said the dependency was
  "NOT DONE YET", so an implementer could wait for, or redo, work dropped
  on purpose. Both now read it as the board does, and one dropped whole
  is marked `[-]` with nothing of it to build on, as is a dropped subtask
  in its parent's brief.
- **A republish can drop a task you had linked to a box.** The links you
  made carried over to the republished diagram and were then checked
  against the new task list, so the whole publish was refused over a link
  the agent never wrote. A carried link to a task no longer in the plan
  now goes with the task, as when it is removed.
- **A config file saved with a byte order mark is read.** Some Windows
  editors (PowerShell 5.1's `Set-Content -Encoding UTF8`, say) start a
  file with an invisible mark. `.coplan/config.json` saved that way was
  "not valid JSON", so no check ran and the error named a character you
  cannot see. `.coplan/config.json`, your own Coplan settings and the
  `package.json` that `coplan init` reads now skip it, and one saved as
  UTF-16 (PowerShell 5.1's `>`) says to save it as UTF-8.
- **Numbered steps read as written.** In task details, notes and
  comments, steps with blank lines between them each started again at 1,
  a list beginning at 3 began at 1, and a code block indented under a step
  came out as garbled text that broke the list in two. They now count on,
  keep their number and keep the code in its step, and a bare link no
  longer takes the sentence's full stop with it.
- **An open editor keeps what you wrote.** A task's detail, the summary,
  a section, a box's notes or a diagram's caption, open and half written,
  was gone when you clicked another tab (or a chip that opens one), went
  to another session and back, or closed the page without being asked.
  It now reopens as you left it, in its own session, and the browser asks
  before you close the page with one unsaved.
- **Ctrl+C on `coplan check` stops the check too.** Each check runs in a
  process group of its own, so a timeout can stop all it started, but
  that also kept Ctrl+C (or an agent ending the command) from reaching it:
  `coplan` quit and the test suite ran on, and a second run raced it. The
  interrupt is now passed on, and `coplan check` exits once the check is
  gone.
- **Your settings' comments survive a second `./setup.sh`.** When setup
  rewrote a settings file that had comments, it kept the original as
  `.bak`; but the line it writes at the top counted as a comment the next
  time, so a second run that changed a setting copied its own output over
  that `.bak`, and your comments were gone. Its own line no longer counts,
  however an editor saved the file since, and a copy never goes over an
  earlier one: the next is `.bak.1`, then `.bak.2`.

### Targeted checks: only what the change touched

- **Every check the build runs is targeted.** A check runs only when the
  change touches its area — its `paths`, or, for a package's check, the
  folder in its `cwd` — and when nothing changed, nothing runs. What a task
  only planned to touch no longer calls for a check; what it edited outside
  the plan still does.
- **A task's change is measured from the commit it began at.** Coplan reads
  it when the task starts — in the task's own worktree when its branch has
  one — and `harness_task_update` gives the command:
  `coplan check implement --since <commit>`. The done gate holds the task to
  exactly those checks, and its refusal names the command. The final checks
  run for the build's change since the base branch.
- **`{files}` in a hook's command** is the changed files in its area, quoted
  (`ruff check {files}`, `eslint {files}`), so the tool itself looks at
  nothing else.
- **`coplan check`** picks what to run from git: `--since <commit>`, else
  what is not committed yet; at `final`, since the base branch. It says which
  checks it left out and why. `--files` now names the files instead of git,
  `--all` runs every check, and `--no-diff` is gone.
- **`coplan init` writes targeted checks**: a typecheck or linter only for
  its language, and `ruff check {files}`. Test suites and builds stay whole,
  for the repository to scope. This repository's own typecheck now runs only
  when TypeScript changes.

### A task's own checks: skip one, or add one, set by you

- **A task can skip one of the repository's checks, or add its own** — a
  docs-only task skipping the test suite, a migration adding
  `pnpm db:check`. Set them in the task's details (*Checks*: untick one to
  skip it, add a command with its stage and whether it is optional), or on
  its card during the build. Subtasks inherit them.
- **Only you set them.** The agent cannot skip a check on the task it is
  building: its edit is refused, and it proposes the change instead
  (`set_checks` in `harness_plan_propose`), which you accept or reject —
  mid-build too.
- **A skip is never silent.** It shows as a chip on the task and its card,
  in the task's brief (*Checks set for this task*), in the read-back and
  what the agent hears changed, in the finish step (the report must say it)
  and under the build report in the Overview.
- **`done` follows them**: a skipped check is not waited on, and its failure
  does not hold the task back; an added check is waited on like the
  repository's, unless optional. `coplan check --skip a,b` leaves skipped
  checks out.

### Checks for what the change touched, Codex hooks that do not run, config errors in the page

- **A file edited outside the plan no longer skips its check.** At `review`
  and `final`, a hook limited to some files (`paths`) runs for the files a
  task planned to touch *and* every file the change touched, as git says:
  committed since the base branch, staged, unstaged or new.
  `coplan check review --files a,b` adds them by itself (and says which
  hooks they brought in); `--base <ref>` says what to measure from (default
  `branches.base`), and `--no-diff` keeps to `--files`. A Managed task is
  not done until it reported those checks too, and the refusal names the
  file. `implement`, which runs before there is a diff, is as before, and so
  is a task that lists no files: it already gets every hook.
- **`coplan doctor` notices when Codex is not running Coplan's hooks.** Codex
  runs a plugin's hooks only once you trust them in `/hooks`, and again
  after every update changes them; until then a thread can use Coplan's
  tools while no sign-off rides along with your messages and no question is
  shown. The doctor now says so when the latest Codex thread that used
  Coplan never had a hook reach it, and how to fix it. Where Codex keeps
  that trust is not documented, so the doctor reads the symptom, not the
  setting.
- **What is wrong with the harness config is said in the page**: each
  problem in `~/.claude/cc-harness/config.json` or a repository's
  `.claude/harness.json` — a setting of the wrong type, one a repository
  may not set, a file that is not JSON — shows once as a toast when you open
  a session, not only in `daemon.log` and the doctor.

### Request revisions from the page: open comments as one ask

- **Request revisions**, in the header, sends every comment waiting on the
  agent as one explicit ask: act on each, reply in its thread, propose what
  is yours to decide, then say what changed. The dialog shows exactly what
  is sent, with each comment on the item it is about, and takes a note.
- **Coplan still never starts a turn.** The request is queued, like a
  sign-off, and your next message in the agent's chat carries it — "go"
  will do — once; a pasted copy is not sent again. Where the session has a
  link, queuing opens it. In Cursor it is copied to paste, or handed over
  with the agent's next `harness_plan_read`.
- **The header shows where it stands**: *pending* (with *Copy request* and
  *Withdraw*), *sent* with how many comments are answered, then *answered*
  once each has a reply, a resolve or a proposal from the agent.

### Four plan statuses: Planning, In progress, Review, Done

- **Every plan shows one of four statuses**, in the same words in the
  header, the session list and the strip under the header: *Planning*
  (designing, or shaping the task list), *In progress* (submitted, or being
  built), *Review* (every task done and the final checks and report under
  way, or a task a Managed build holds for your review) and *Done* (built,
  or exported). The detail follows it: *design confirmed*, *waiting for
  Claude*, the task Claude is on, what waits on you, *exported*.
- **Planning has a pill in the session list too**, where a plan still being
  designed used to show none.
- **The session list filters by status**, with how many plans each holds;
  the choice is remembered.
- `GET /api/sessions` carries each plan's `planStatus` and how many tasks
  wait on your review (`awaitingReview`).

### Proceed from chat: "build it" moves the plan, without the sign-off dialogs

- **Tell the agent to go ahead, and it signs the plan off for you.** A new
  tool, `harness_plan_advance {to: "tasks" | "build", user_said}`, confirms
  the design or submits the plan exactly as *Confirm design* and *Submit*
  would: the same prompt, the same lock, the same `planCheck` errors holding
  it. The agent decides whether what you said means go ahead, and quotes
  you: without your words the tool refuses. Its answer is the prompt the
  page would have sent, so nothing is handed over again with your next
  message.
- **A go-ahead in chat builds the way you last chose.** Picking a mode or a
  Managed setting in *Submit* is remembered for the session, even if you
  close the dialog, and the dialog opens on it next time. With no choice
  made, the repository's defaults apply.
- **The page says when a sign-off came from chat**: *confirmed from chat* or
  *submitted from chat* in the strip under the header, with what you said.
- **Confirming the design is optional.** *Submit plan* sits beside *Confirm
  design*, and "build it" works straight from the design: the build follows
  the tasks planned on the diagram, and the design locks with the plan.
- **No prompt or skill tells the agent to wait for a click in Coplan.** The
  design prompt, the read-back's lock line, `harness_task_next` before
  submission, the reply to publishing a task list and the `coplan` and
  `coplan-build` skills now say to start when you say so — in chat or by
  submitting in Coplan.
- Fixed: a Tracked build read back as Managed after the daemon restarted,
  because a submission's mode was not kept on disk.

### The diagram as the task breakdown: a task list on every box

- **Every box but a note counts the tasks that build it**, in a chip at its
  foot: `☐ 0` before any task does, `☐ 1/3` once one of three is done
  (a linked task counts as its subtasks), with their progress beside it.
  It shows while you design and during the build.
- **The chip opens the box's task list**: each task with its status and its
  *Brief*, and, until the plan is submitted, a field to add one — it is
  created with `builds: [this box]` and appears in the Tasks view, linked —
  a title to rename and a way to unlink it. The list is reached without the
  mouse: **Tab** to the chip, or **Alt+Enter** on a selected box, or the
  box's menu; **Esc** closes it, back on the chip. Keys in it stay in it, so
  typing there never renames or deletes the box, and Tab, Enter and typing on
  the chip are the chip's (#30's rules hold). Adding a task from a box is not
  a drawing edit: undo leaves it linked, and the canvas's history stands.
- **A box no task builds says *no task*,** exactly where the plan check lists
  `box-unbuilt` — never on a note, an actor or an external system, nor
  before the plan has tasks — and not at all when the repository's
  [`planCheck`](docs/CONFIG.md#plancheck) turns that rule off.
  `GET /api/session/:id` now carries `planCheck` for it.
- **The Tasks view lists them *By box***, beside the outline and the board
  (and beside the board once the plan is submitted): each box with the tasks
  that build it, and *Not on the diagram* for the tasks that build no box.
- Every box but a note now has room for its chip, so boxes are a little
  taller, and linking a task never resizes one.
- Closing *What Claude reads* puts the keyboard back where it was opened
  from, and saving or abandoning an inline title from the keyboard leaves
  the keyboard on it.

### The build harness is opt-in: Export, Tracked and Managed

- **Submit asks how the plan is built**, in place of *Who builds it?*:
  - **Tracked**: the agent builds it its own way and reports each task, and
    the board follows. The build prompt has no implement → review → refine,
    no review mode, no round or parallel limit. Nothing the agent reports is
    refused: where a Managed build would hold a task back — done before any
    review, without a passing verdict, while a check fails or was never
    reported, past the parallel or round limit, dropping work you signed
    off — `harness_task_update` succeeds and its reply says what was skipped.
  - **Managed**: today's build, unchanged — every task through implement →
    review → refine, held to the repository's checks.
  - **Export**: the plan as Markdown, copied to build somewhere else, with
    this version locked here. It replaces *Somewhere else*, whose prompt
    still prescribed the review cycle.
- **The default comes from `.coplan/config.json`**: a new
  [`mode`](docs/CONFIG.md#mode) key, or Managed where the file sets `iric`.
  **A repository with neither now defaults to Tracked**; one with `iric` —
  as `coplan init` writes — stays Managed. Your own `coplan.json` can set
  `mode` for every repository.
- **Export plan**, in the header, shows the whole plan as Markdown — summary,
  sections, diagrams, the task list and order, a brief for every task, and
  the open comments — with no build instructions, review modes, round
  limits or Coplan tool names. It works from every view and in every phase,
  copies or downloads it, and signs nothing off.
  `GET /api/session/:id/plan/export` serves it.
- `harness_task_next` and each task's brief follow the mode: a Tracked
  build's say nothing of the cycle, review rounds or subagents.

### Fewer assumptions, fewer questions

- **One rule for when the agent asks you anything**, stated once in the
  `coplan` skill and in every prompt: only when a decision cannot be undone,
  reaches outside the session (pushing, opening a pull request), or is yours
  by right — in a Managed build, dropping work you signed off, a task you
  review, a review round past your limit, or taking a task whose checks
  fail. Anything else it decides, writes down where you will see it, and
  carries on. The other instructions to ask are gone: no more "ask whatever
  you need decided" after every publish and task list, or "stop and ask"
  when stuck. A contract test fails if a new one appears outside those
  cases.
- **Neutral build defaults.** Without `iric`, a build's defaults are
  self-review, one task at a time and three review rounds — no subagents or
  worktrees assumed. A repository that wants a subagent reviewer or more at
  once says so in `iric` (`coplan init` writes the defaults out to change),
  or you choose it in Submit. Pull requests still wait for your go-ahead by
  default (`pullRequests.open: "ask"`).
- The `coplan-build` and `iric` skills no longer prescribe how the agent
  works: subagents, worktrees and parallel work when the agent has them and
  they help; commits in whatever granularity the repository's history uses;
  the reviewer's prompt as a suggestion rather than a script.

### Every word traceable: where each part of a prompt comes from

- The *Confirm design* and *Submit* dialogs list each setting the prompt
  takes from config — the checks for each stage, the default review mode,
  branches, how pull requests are opened, the reviewer model, whether
  failing final checks hold the report, and your standing instructions —
  read-only, grouped by the file that sets it (`.coplan/config.json`, or
  your own `coplan.json` and `instructions/*.md`) with each key, and a link
  to where [docs/CONFIG.md](docs/CONFIG.md) describes it. A setting no file
  sets says so: it is Coplan's default.
- A prompt too long for one message now says what it leaves out — "3
  sections, the architecture (2 diagrams) and the detail of 12 tasks" —
  instead of only that it is long.
- **What Claude reads**, in the header (it was *As Claude sees it*), is one
  viewer for everything the agent is sent: the read-back, the next prompt
  (or the one already sent) and any task's brief, exactly as
  `harness_task_brief` gives it. Every task in the outline and on the board
  has a *Brief* button that opens it. Each part shows where it comes from:
  click a box, arrow, section or task to go to it; a config setting shows
  its file and key. The sign-off dialogs show their prompt the same way.
- The agent's bookkeeping — revisions, who edited what, reply hints, its
  proposals, the gaps and the status legend — is hidden behind an *Agent
  bookkeeping* toggle, and what a prompt leaves out to fit is shown struck
  through. Looking does not count as the agent reading the plan.
- Under the hood, the daemon builds each prompt, the read-back and each
  brief from blocks that name their source (a field of the plan, a config
  key, the dialog, what Coplan works out, or its fixed instructions). The
  preview endpoints return them, and `GET /api/session/:id/plan/readback`
  and `GET /api/session/:id/task/:taskId/brief` serve the other two. The
  text the agent gets is unchanged, byte for byte.

### Installing: clone, then `./setup.sh`

- Coplan is not listed in any agent's plugin directory, and the install
  instructions now say so. You clone the repository and run `./setup.sh`,
  which builds Coplan and, once you say yes, installs it in every agent it
  finds (Claude Code, Codex, Cursor). The README's install is two commands;
  [docs/INSTALL.md](docs/INSTALL.md) has the rest.
- *Adjust settings now?* (default no) asks for the settings people most
  often change — who reviews each task, how many are built at once, how pull
  requests are opened, whether the plan opens by itself — and offers to
  write a repository's checks (`.coplan/config.json`) from its scripts. It
  writes only what you change, and keeps a file you wrote comments in as
  `<file>.bak` before rewriting it.
- `git pull && ./setup.sh` updates, and restarts a running daemon on the
  new build. `./setup.sh --uninstall` takes Coplan out of every agent, stops
  the daemon, and asks before deleting your saved plans. `--yes` asks
  nothing; `--agents` picks the agents.
- The agents install `.plugin/`, a copy of what runs staged in the clone:
  about 5 MB, where installing the clone itself copied its 150 MB of
  build-time packages into each agent.
- If you installed Coplan straight from GitHub, `./setup.sh` from a clone
  moves the `coplan` marketplace to the clone, in Claude Code and in Codex.
- `/coplan-setup` now says which version is installed and where to run
  `./setup.sh`; it still builds a checkout loaded with `--plugin-dir`.
- `coplan setup` writes a repository's `.coplan/config.json` without the
  build settings when you have your own defaults, so they hold there.
  `coplan init` is unchanged.

### The README

- **Screenshots** of each step, from demo plans that
  `scripts/demo/screenshots.mjs` seeds into a throwaway daemon, so they can be
  taken again when the page changes.
- **What it installs:** every skill (when the agent uses it, and what it may
  lead the agent to do), the MCP server and its ten tools, every hook with
  what it sends and what is kept, the slash commands, the CLI, and what
  Coplan reads, writes and connects to.
- **Resource footprint:** measured memory, CPU, latency, disk and context
  size for the daemon, the MCP server, the hooks and the page, and what
  drives the cost of a build.
- **Recommended usage:** when Coplan is worth it, and how to set up checks,
  size a plan, and choose the review mode, parallelism and round limit.
- The step-by-step walkthrough moved to [docs/GUIDE.md](docs/GUIDE.md).

## 0.3.0

### The plan the agent reads is the plan you see

- The agent can no longer write over a change you made that it has not read
  yet: the edit is refused with what to read first. Tasks carry a revision,
  so two writers cannot silently overwrite each other.
- The agent is sent every change you made, and the build prompt it receives
  is exactly the one you read in the dialog: a prompt that changed after you
  read it is refused, not sent. Text you write cannot break the prompt's
  structure.
- Skills and docs use the real `harness_plan_edit` API; a test checks every
  example against the tool schemas.
- A daemon's lock is trusted only once that daemon answers, and is claimed
  atomically, so two daemons cannot both think they own it.

### The agent as auditor

- The agent can comment on the plan, a box or an arrow without changing it,
  read the plan without marking it read (`peek`), and add, change or remove
  one box or arrow without restating the whole diagram.
- `harness_plan_check` lists what the plan leaves open: tasks with no
  detail, boxes no task builds, branches a stack of pull requests cannot
  follow.
- A subagent's brief carries the plan's sections and the comments on the
  boxes it builds.

### Stacked pull requests and the build lifecycle

- Branches are planned so a stack of pull requests can follow them, and
  tracked as they are pushed and opened (`harness_branch_update`); a build
  ends with its report.
- Every path to *done* goes through the task's gates: a review round with a
  verdict, passing checks, and every required review hook reported.
- Scope can change mid-build without re-scoping what you signed off.

### Hardening

- The access token is never a cookie and never on a command line: the page
  keeps it for its own origin and sends it as a header, the live stream uses
  single-use tickets, and Coplan's files are readable by you alone.
- A plan that cannot be saved says so instead of failing silently. A save is
  written whole and synced before it replaces the old one.
- *Answer in …* opens Claude, Codex and Cursor session links, checked first.
- The canvas keeps undo consistent with what is saved, waits for a save in
  flight before Confirm or Submit, leaves Tab and Enter to the toolbar, and
  F6 moves between the canvas and its details.
- Hook `paths` take `{a,b}` and `!glob`; config files take comments and
  trailing commas; unknown keys and bad values are reported, saying what is
  used instead. `config/defaults.json` is gone.
- An installed but unbuilt plugin says so at the start of a session.
  `coplan doctor` checks node, curl, both configs, the daemon's version and
  pid, and a hook sent through the real relay, and cleans up after itself.

### Proposals: the agent suggests, you decide

- `harness_plan_propose` lets the agent suggest a change instead of making
  it: a batch of edits with its reason. It waits beside the plan with
  *Accept* and *Reject*, and *Show on canvas* draws the diagram as it would
  be, marking what it adds, changes and removes. Accepting applies the
  edits as yours; rejecting keeps the plan and tells the agent why. The
  agent hears the answer the next time it reads.
- A proposal is checked when it is made, and goes out of date if what it
  changes moves first. Once the design is confirmed or the plan submitted,
  it is how the agent suggests what it may no longer change itself.

### Make the build yours

- `pullRequests` in `.coplan/config.json` chooses how a build's pull
  requests are opened — `gh`, Graphite, or by you — and when: as each
  branch is done, once you say, or never; with a `template` each
  description is written from. `harness_task_next` says when each is due.
- `instructions` add your own words to the design prompt, the build prompt,
  every task's brief, and what its reviewer checks.
- `review.model` picks the reviewer subagent's model; `final.blocking`
  holds the build report until the final checks pass.
- `planCheck` sets how each plan-check rule counts: an `error` holds
  *Confirm design* and *Submit*, a rule turned `off` is not shown.
- A hook can run in a folder (`cwd`) with its own variables (`env`), for a
  monorepo.
- `~/.claude/cc-harness/coplan.json` and `instructions/*.md` there are your
  defaults for every repository, under each repository's own config.

### The same Coplan in every agent

- The commands find the plugin where an agent leaves its path empty; the
  docs list the commands each agent really ships; Codex's question hook
  covers `request_user_input_async`.
- Platform support is stated: Linux and macOS, and Windows through WSL.
- CI runs on macOS too, on the oldest supported Node (20.11.0), lints the
  shell scripts, and validates the Claude Code plugin; each release is tagged.

### The session list holds only your plans

- **Only sessions that used Coplan are listed.** Every session with the
  plugin registers, so the list used to fill with chats that never asked for
  a plan. A session now joins it once you type `/coplan` (`$coplan` in
  Codex), the agent loads the skill itself, or it calls a Coplan tool;
  sessions that already have a plan stay. The session on screen is always
  listed, so a `/coplan-open` link never strands you.
- **Row actions no longer sit on the title.** Rename, pin and delete keep a
  space of their own at the end of a row's first line, on touch screens too,
  and step aside while you rename. A long branch or folder name is cut short
  on its line instead of breaking across several, and the folder name is
  left out when the group header already says it.

### Build after installing, with pnpm

- The project uses **pnpm**: `pnpm-lock.yaml` replaces `package-lock.json`,
  and `packageManager` pins the version for corepack. `pnpm install` installs
  and builds; `pnpm check` runs everything CI does.
- `dist/` is no longer committed. After installing or updating the plugin,
  build it once: `/coplan-setup` in Claude Code or Cursor, or ask Codex to set
  up Coplan (each runs `pnpm install` in the plugin's directory, which builds
  it), then restart the agent. Until then the plugin's tools and hooks stay
  off, and `coplan` says how to build it. CI no longer compares a committed
  `dist/` with the source.

### Design first, then a linked task list, then a reviewed build

- **Confirm the design before the task list.** The Architecture view's main
  action is now *Confirm design*: it shows exactly what the agent will be
  asked, and confirming locks the diagrams, sections and summary. Your next
  message carries the design to the agent (in Cursor you paste it, or its next
  `harness_plan_read` picks it up), which breaks the planned tasks into the
  task list with the new `harness_tasks_publish`. The title, the tasks, which boxes
  they link to and comments still change; *Reopen design* unlocks the rest.
  Submitting now needs a confirmed design, and *Reopen for changes* after
  submitting unlocks the tasks while the design stays confirmed.
- **Tasks say what blocks them, and where they land.** Each task can depend
  on others (`dependsOn`; a parent's apply to its subtasks, and depending on
  a parent waits for all of it), name a branch (inherited by subtasks), set
  its own review mode, and link the boxes it builds (`builds`). Loops and
  dependencies on a task's own parent or subtask are refused with the reason.
  The Tasks view marks each task *ready* or what it *waits on*, edits all of
  this in a task's details, and shows the **build order** — steps of tasks
  that can be built side by side — and how the **branches stack** into pull
  requests. The read-back and the prompts carry the same.
- **What can start, and one task's brief.** `harness_task_next` lists the
  ready tasks, how many to run at once, what is in progress and at which
  step, and what the rest wait on — and, once everything is done, how to
  finish. `harness_task_brief` gives one task self-contained, to hand to a
  subagent: the objective, the boxes it builds with their decisions and
  connections, what it comes after and before, its scope, its branch, and
  its checks.
- **Implement → review → refine, under your control.** The submit dialog
  sets how each task is built: who reviews it (a fresh subagent, the agent
  itself, you, or the checks alone), how many tasks run at once, and how
  many review rounds before the agent stops and asks you. `harness_task_update`
  reports a task's step and the checks it ran; starting a task that still
  waits on another is refused, and so is marking one done while its last
  checks failed. Board cards show the step, the round and the checks.
- **Checks in `.coplan/config.json`.** A repository lists what every task
  runs, per stage (`implement`, `review`, `final`), with the build's defaults
  and its base branch. The checks reach the agent in the prompts and briefs;
  `coplan check <stage>` runs a stage and shows only what failed, and
  `coplan init` / `/coplan-init` writes a starting point. Coplan never runs
  them itself.
- **Skills for the build.** `coplan-build` runs a submitted plan: ready
  tasks only, independent ones in parallel by subagents (in worktrees when
  on different branches), stacked branches and pull requests, and the final
  report. `iric` is one task's implement → review → refine cycle, with a
  reviewer prompt and the round limit. `coplan` now covers the design and
  the task list.
- **The build report.** Once every task is done the agent writes a report with
  `harness_plan_edit {op: "report"}`; it leads the Overview.

### Codex and Cursor

- Coplan now works in **Codex** and **Cursor** as well as Claude Code. The
  same repository is a plugin for all three: `.codex-plugin/plugin.json` and
  `.cursor-plugin/plugin.json` sit beside `.claude-plugin/`, each pointing at
  that agent's own hooks (`hooks/codex.json`, `hooks/cursor.json`) and MCP
  config (`mcp/codex.json`, `mcp/cursor.json`). Install with
  `codex plugin marketplace add bert-bae/coplan` and
  `codex plugin add coplan@coplan`, or from Cursor's plugin search with the
  repository's URL.
- Codex keeps a plugin's hooks off until you trust them: open `/hooks` in
  Codex once after installing (and after each update).
- Every session records which agent it runs in. The page names it — "Codex
  is working", *Answer in Cursor* — and the session rail labels each row
  once more than one agent is in the list. `coplan status` shows it too.
- Each agent is told to ask with its own question tool: `AskUserQuestion` in
  Claude Code, `request_user_input` (Plan mode) in Codex, `AskQuestion` in
  Cursor. A Codex `request_user_input` or permission request shows the
  waiting banner; *Answer in Codex* opens the thread in the Codex app
  (`codex://threads/…`).
- Codex's MCP server finds its thread from each tool call. Cursor's, which
  one window shares across its chats, finds the chat in its workspace that
  was active last, asking Cursor for the workspace (MCP roots) when its
  config cannot say.
- Cursor's hooks cannot reliably add to a prompt, so in Cursor submitting a
  plan copies the build prompt for you to paste; pasting it counts as
  delivering it, and so does the agent's first `harness_plan_read` after you
  submit ("build the plan" will do).
- `coplan open` and `coplan url` find the session they were run from in any
  agent, falling back to the one most recently active in the current folder.
- `coplan doctor` checks the Codex and Cursor files and replays a hook in
  each agent's format.

### Renamed to Coplan

- The project is now **Coplan**, open source under the MIT license. The
  repository moved to `bert-bae/coplan`; GitHub redirects the old address.
- The plugin and its marketplace are both named `coplan`, so it installs
  straight from GitHub with `claude plugin marketplace add bert-bae/coplan`
  and `claude plugin install coplan@coplan`. If you installed
  `cc-harness@cc-harness-local`, uninstall it, remove that marketplace, and
  install `coplan@coplan`.
- The slash commands are `/coplan`, `/coplan-open`, `/coplan-doctor` and
  `/coplan-restart` (they were `/harness…`), and the CLI is `bin/coplan`
  (it was `bin/harness`). The hook relay is `bin/coplan-hook-relay.sh`, so
  nothing generic lands on your `PATH`. The UI, the CLI and what Claude is
  told all say Coplan.
- The MCP tools and the data directory keep their old names
  (`harness_plan_*`, `~/.claude/cc-harness`, `CC_HARNESS_HOME`,
  `.claude/harness.json`), so existing plans and configuration carry over
  unchanged.

### Submitting the plan

- **Review & submit plan**, on the Architecture view, shows the exact prompt
  Claude will be given — built by the daemon from the plan as it stands, with
  anything you add for Claude and what you changed that it has not read yet
  — and submitting locks the plan. The preview is rebuilt as you type, and a
  submission made against a plan that moved on since is refused.
- **Who builds it**: this Claude session, which gets the prompt with your
  next message in its chat (once; pasting it yourself is not sent twice), or
  somewhere else, with a prompt written for an agent without the harness
  tools, copied for you to paste.
- **Locked.** A submitted plan is the final design: the canvas is read-only
  (boxes still fill up with progress, and a box's panel links each task to
  its card), the Tasks tab is a read-only board, and the Overview's controls
  are off. Claude can still report tasks, add work it discovers and answer
  comments; redesigning and republishing are refused until every task is
  done. *Withdraw* or *Reopen for changes* unlocks it.
- **Following the build.** A strip under the header says whether Claude has
  the prompt, which task it is on, what is blocked, and when it is built. On
  the board, a card that changes column glows as it arrives, and the move is
  announced to screen readers. The session rail shows *submitted*,
  *building* or *built*.
- A plan too long for one message is sent as the instructions, summary and
  task list, with a pointer to `harness_plan_read`; the review says so.

The architecture canvas is easier to fill in and opens organised, and what
Claude reads back about it is the design you ended up with — not a replay of
every drag and keystroke.

### Editing the canvas faster

- **Right-click menus** for empty canvas (add a box of any kind right there,
  paste here, tidy, fit), a box (rename, kind, add after/before/beside,
  connect to, copy, duplicate, delete keeping the flow), an arrow (label,
  reverse, dashed, arrowheads, insert a box, delete) and a selection. ⇧F10
  or the menu key opens the same menu from the keyboard.
- **Reconnect by dragging an arrow's end.** A selected or hovered arrow shows
  a grip at each end; drag one onto another box. The arrow keeps its label
  and style.
- **Relationship highlighting.** Hover or select a box: what it sends to,
  what sends to it and two-way links each get their own colour and a badge
  in words, their arrows flow in their direction, and everything else fades.
  Hold Alt for two steps out. An arrow lights up its two ends.
- **Undo and redo** (⌘/Ctrl+Z, ⇧⌘/Ctrl+Z, toolbar ↶ ↷) for every canvas
  edit. A change made elsewhere ends the history rather than being undone.
- **Building by keyboard**: Tab adds the next box along the flow, ⇧Tab one
  before, Enter one beside (same kind, same parents); typing on a selected
  box renames it.
- **Drop a box onto an arrow** to put it in between; **Alt+⌫** deletes a box
  and joins the flow around it.
- **⇧1** fits the diagram, **⇧2** zooms to the selection, **?** lists every
  shortcut.

### What Claude reads

- **Diagrams read as an architecture.** `harness_plan_read` (and *Copy as
  Markdown* on the diagram panel) renders each diagram as the system's shape —
  entry points, data stores, queues, external systems — then every part in
  the order the flow reaches it, with its role, description, decisions and
  the tasks that build it, then every connection in words. No coordinates,
  no layout direction.
- **"Since you last read" is the net change.** It compares the plan Claude
  last read with the plan now: a box added and deleted again leaves nothing,
  a box renamed three times is reported once by its final name. Changes are
  grouped — parts added, removed, changed; connections connected,
  disconnected, reversed, restyled — and `changes_only` quotes edited prose
  in its final form.
- **Layout is not news.** Dragging boxes or flipping the direction is saved
  but never counts as a change for Claude, in the read, the prompt notice or
  the header.

### On the canvas

- **Descriptions.** Every box has a description (what it does, what it owns,
  how others talk to it) beside its decisions. Claude is asked to fill both
  in while planning. Hover a box's ⓘ for a summary: description, decisions,
  the tasks that build it and its connections.
- **Organised from the start.** Layout leaves room between ranks for arrow
  labels, routes arrows around the boxes they pass, puts unconnected boxes on
  a shelf instead of beside the flow's start, never zooms a small diagram
  past its real size, and picks top-to-bottom for long, narrow flows when
  Claude does not say. A box Claude adds to an arranged diagram lands beside
  what it connects to.
- **Editing.** Double-click empty canvas to add a box; drag from any edge of
  a box onto another to connect, or into space for a new connected box;
  double-click a box or an arrow's label (or F2) to rename it in place.
  Arrows join whichever sides face each other, so moving a box never leaves
  them looping round it.
- **Copy and paste.** ⌘/Ctrl+C, X, V and D copy, cut, paste and duplicate
  boxes with everything on them and the arrows between them, across diagrams
  and tabs. ⌘/Ctrl+A selects everything.
- **Connections** can be reversed, re-pointed, made dashed, and drawn one
  way, both ways or without direction, from their panel; a box's panel lists
  its connections with a way to add and remove them.
- **The panel's fields fit what goes in them:** inputs for a name, a
  subtitle and an arrow's label; a growing textarea for a description; a
  markdown editor for decisions; a visual kind picker. Several selected
  boxes can have their kind changed at once.

## 0.2.0

The harness is now a planning workspace: architecture and task breakdown in,
progress out. Every exchange with Claude happens in Claude's own chat.

### Changed

- **Planning only.** The review loop is gone — gates that held turns open,
  diff review, checks, ship, the message box. The harness never talks to
  Claude and never holds a turn.
- **Architecture first.** Diagrams are React Flow canvases (about 70% of the
  view) with a details panel: label, kind, one-line detail, markdown notes and
  decisions, the tasks that build each box, and its connections. Boxes show
  their tasks' progress. dagre lays out what Claude publishes.
- **Tasks** as an outline you reshape (drag to nest, Alt+arrows) and a status
  board you follow; rows link to the boxes they build.
- **Questions are answered in Claude.** `AskUserQuestion`, permission and
  idle prompts, and turns that end on a question show as a banner with
  *Answer in Claude*, linking to the session in the desktop app
  (`claude://claude.ai/code/session_…`) or on the web. Cloud sessions and
  local sessions with Remote Control get a link; others get a hint.
- **Four MCP tools**: `harness_plan_publish`, `harness_plan_read`,
  `harness_plan_edit`, `harness_task_update`.
- The session list folds to a rail of initials (☰ or `[`).

### Hardening

- Saves carry the revision they were made against; a save over a newer
  change (Claude's or another tab's) is refused rather than silently
  overwriting it. Editors keep your text when that happens. Canvas saves are
  serialized and coalesced.
- An unreadable state file is moved aside (`state.corrupt-*.json`) instead of
  being overwritten; plans from any earlier build are normalized on load.
- The UI is served with a strict Content-Security-Policy, `no-referrer`
  (the first URL carries the auth token), `nosniff` and frame denial.
- Cross-origin writes are refused even with valid credentials; malformed JSON
  and paths are 400s; request bodies are capped at 2 MB; server timeouts are
  bounded.
- Live updates stream only the session a page is showing, and the session
  list broadcast is coalesced per tick.
- Plans are bounded: tasks, sections, diagrams, boxes, arrows, comment
  threads and replies.
- A view that fails to render shows an error card instead of a blank page;
  loading and unavailable-session states replace the "no session" flash.
- CI: typecheck, build, a check that committed `dist/` matches the source,
  tests, the `harness doctor` self-test, and `npm audit` on Node 20 and 22.

### Migration

Sessions saved by 0.1 load automatically: plan steps become tasks, and
review-loop state is dropped. Old config keys (`gateHoldSeconds`, `ship`, …)
are ignored. New key: `openClaudeOnQuestion`.
