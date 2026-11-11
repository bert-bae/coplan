/**
 * Shared vocabulary for every process in the harness: the daemon, the MCP
 * server, the hook relay and the browser UI all speak these types.
 *
 * The harness has two jobs: to be the place where a plan is laid out,
 * reshaped and broken down, and to show how far Claude has got through it.
 * Everything here describes a plan document — its prose, its diagrams, its
 * task tree and the comments on them — plus whether Claude is waiting on the
 * user. Nothing here describes talking to Claude: questions are asked and
 * answered in Claude's own chat, and the harness only links there.
 *
 * "Claude" in these names is the agent on the other side of the plan, which
 * may be Claude Code, Codex or Cursor: `Author` `'claude'` and
 * `claudeReadAt` mean "the agent", and keep their names so saved plans load.
 */

import type { AgentKind } from './agents.ts';

/** Who made a change. The plan is co-authored, and the change log is how each
 *  side finds out what the other did. */
export type Author = 'user' | 'claude';

/** What the session is doing right now, as far as the hooks can tell. Shown
 *  for orientation only — nothing in the harness waits on it. */
export type SessionStatus = 'active' | 'idle' | 'ended';

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** A titled block of markdown: context, goals, the architecture in prose,
 *  risks, what was ruled out. Ordered; the user can reorder them. */
export interface Section {
  id: string;
  title: string;
  body: string;
  /** Bumped on every change. An editor sends the revision it started from,
   *  and a save over someone else's newer change is refused, not merged. */
  rev: number;
  updatedAt: number;
  updatedBy: Author;
}

/** What a box on a diagram stands for. Drives its shape and colour, so a
 *  reader can tell a datastore from a service without reading the label. */
export const NODE_KINDS = ['component', 'service', 'datastore', 'queue', 'external', 'actor', 'note'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface DiagramNode {
  /** Short slug, unique within the diagram — edges refer to it. */
  id: string;
  label: string;
  kind: NodeKind;
  /** One line under the label on the canvas: responsibility or technology. */
  detail?: string;
  /** What this part is and does — what it owns, how others talk to it. A
   *  short paragraph, shown in the box's hover summary. Markdown. */
  description?: string;
  /** The longer story, edited in the side panel: decisions taken about this
   *  part and why, interfaces, open concerns. Markdown. */
  notes?: string;
  /** Tasks that build this part, so the diagram shows how far along it is. */
  taskIds?: string[];
  /** Canvas position. Absent until someone arranges the diagram; the UI lays
   *  out unplaced nodes automatically. */
  x?: number;
  y?: number;
}

/** Which ends of an arrow carry a head. `end` — the default, and never
 *  stored — points from source to target. */
export const EDGE_ARROWS = ['end', 'both', 'none'] as const;
export type EdgeArrows = (typeof EDGE_ARROWS)[number];

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Dashed for optional, async or future connections. */
  dashed?: boolean;
  /** Absent means `end`. */
  arrows?: Exclude<EdgeArrows, 'end'>;
}

export type DiagramDirection = 'LR' | 'TB';

/**
 * A diagram is a graph of boxes and arrows, drawn on a canvas the user can
 * rearrange, rewire and relabel — and that Claude reads and writes as the same
 * nodes and edges.
 */
export interface Diagram {
  id: string;
  title: string;
  /** Bumped on every change; see `Section.rev`. */
  rev: number;
  /** The revision at which its boxes, arrows or direction last changed. A
   *  save of the graph made against any revision since is not refused for a
   *  title or caption edited meanwhile. Absent where a diagram was saved
   *  before it was kept: then `rev` stands for it. */
  graphRev?: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Which way automatic layout flows. When Claude leaves it out, the
   *  harness picks the one that suits the graph's shape. */
  direction: DiagramDirection;
  caption?: string;
  updatedAt: number;
  updatedBy: Author;
}

/** Nodes and edges as written by Claude or sent by the canvas. */
export interface DiagramNodeInput {
  id: string;
  label?: string;
  kind?: string;
  detail?: string;
  description?: string;
  notes?: string;
  taskIds?: string[];
  x?: number;
  y?: number;
}

export interface DiagramEdgeInput {
  id?: string;
  source: string;
  target: string;
  label?: string;
  dashed?: boolean;
  arrows?: string;
}

export interface DiagramInput {
  id?: string;
  title: string;
  nodes?: DiagramNodeInput[];
  edges?: DiagramEdgeInput[];
  direction?: DiagramDirection;
  caption?: string;
}

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Who reviews a task in its implement → review → refine cycle (iric):
 *
 * - `subagent` — a fresh agent that did not write the change reads it, runs
 *   the review checks and says what to refine.
 * - `self` — the agent that built it reviews its own diff and runs the checks.
 * - `user` — Claude stops and asks the user to look before it is done.
 * - `skip` — no review beyond the checks: for trivial, mechanical work.
 */
export const REVIEW_MODES = ['subagent', 'self', 'user', 'skip'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** A review's outcome: it passed, or it asked for changes. */
export const VERDICTS = ['pass', 'changes'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewRecord {
  round: number;
  verdict: Verdict;
  /** The user (in Coplan, or as the agent reports with their words), or the agent. */
  by: Author;
  /** The review mode in force when it was given. */
  mode: ReviewMode;
  /** One line: what the review found. */
  summary?: string;
  at: number;
}

/** Where a task in progress is in its implement → review → refine cycle. */
export const IRIC_STAGES = ['implement', 'review', 'refine'] as const;
export type IricStage = (typeof IRIC_STAGES)[number];

/** One check run against a task's change — a repository hook from
 *  `.coplan/config.json` — and how it came out. */
export interface CheckResult {
  name: string;
  ok: boolean;
  /** One line: what failed, or what it covered. */
  note?: string;
}

/**
 * One node of the task tree. Tasks nest to any depth through `parentId`;
 * siblings are ordered by `order`. The tree is the breakdown Claude works
 * through, and the statuses are how progress is tracked against it.
 */
export interface Task {
  id: string;
  /** Null for a top-level task. */
  parentId: string | null;
  order: number;
  title: string;
  /** Markdown: approach, acceptance criteria, gotchas. */
  detail?: string;
  status: TaskStatus;
  /** Files this task is expected to touch — a planning aid, not a record. */
  files?: string[];
  /** A one-line status note: why it is blocked, what was done. */
  note?: string;
  /**
   * Tasks that must be done before this one can start. Subtasks inherit
   * their parent's: a task waits until everything it or any of its
   * ancestors depends on is done. A task left out of every chain can run in
   * parallel with the rest.
   */
  dependsOn?: string[];
  /** The git branch this task's work lands on. Subtasks inherit it. A task
   *  whose dependencies are on another branch stacks on that branch. */
  branch?: string;
  /** How this task is reviewed, when not the build's default. Inherited. */
  review?: ReviewMode;
  /** Where the task is in its implement → review → refine cycle, while it is
   *  in progress. */
  stage?: IricStage;
  /** How many times it has gone to review. */
  round?: number;
  /** The checks last run against it. */
  checks?: CheckResult[];
  /** The commit checked out where it was built when it started: its change
   *  — what its checks are targeted to — is everything since. */
  startCommit?: string;
  /** What the task says — title, detail, note, files, dependencies, branch,
   *  review — has been edited this many times (1 when new). Progress
   *  (status, stage, checks) is not counted. */
  rev?: number;
  /** The revision each side last edited, so an edit made against an older
   *  revision is refused only when the other side changed it since. */
  revBy?: Partial<Record<Author, number>>;
  /** Added once the plan was submitted: work found during the build, not
   *  part of what the user signed off. */
  addedInBuild?: boolean;
  /** Each review's verdict, newest last: who gave it, in which round, under
   *  which review mode. Done needs a pass for the current round. */
  reviews?: ReviewRecord[];
  /** Checks of its own, on top of the repository's (#54): required unless
   *  `optional`. The user's to set (`set_checks`), or an accepted proposal's.
   *  Subtasks inherit them. */
  addChecks?: TaskCheck[];
  /** Names of the repository's checks this task does not run: the user's to
   *  set, never the agent's, and shown wherever the task's checks are. */
  skipChecks?: string[];
  createdAt: number;
  updatedAt: number;
  createdBy: Author;
}

/** The stages a task's own check can run at: the final checks are the
 *  whole build's, not one task's. */
export const TASK_CHECK_STAGES = ['implement', 'review'] as const;
export type TaskCheckStage = (typeof TASK_CHECK_STAGES)[number];

/** A check one task adds to the repository's (#54). */
export interface TaskCheck {
  name: string;
  /** A shell command, run from the repository root. */
  run: string;
  /** When it runs; `review` checks gate done. */
  stage: TaskCheckStage;
  /** A failure is reported but does not hold the task back. */
  optional?: boolean;
}

/** What a comment is attached to. `plan` targets the plan as a whole; a
 *  `node` or `edge` is one box or arrow, its id `diagramId/nodeId` or
 *  `diagramId/edgeId`. */
export const TARGET_KINDS = ['plan', 'section', 'diagram', 'task', 'node', 'edge'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface Target {
  kind: TargetKind;
  /** Empty for `plan`. */
  id: string;
}

export interface Reply {
  id: string;
  author: Author;
  text: string;
  ts: number;
}

/** A comment and its replies, anchored to one item of the plan. */
export interface Thread {
  id: string;
  target: Target;
  author: Author;
  text: string;
  ts: number;
  resolved: boolean;
  replies: Reply[];
}

export type ChangeKind =
  | 'published'
  | 'created'
  | 'edited'
  | 'moved'
  | 'status'
  | 'deleted'
  | 'commented'
  | 'replied'
  | 'resolved'
  | 'reopened';

/**
 * One entry of the plan's change log.
 *
 * `seq` increases monotonically per plan. Claude's read position is a `seq`,
 * so "what has the user done since you last looked" is a filter on this list,
 * not a diff of two documents.
 */
export interface Change {
  seq: number;
  ts: number;
  author: Author;
  kind: ChangeKind;
  target: Target;
  /** One line, in words: `moved "Add cache" under "Storage layer"`. */
  summary: string;
}

/**
 * Who builds a submitted plan.
 *
 * - `session` — the Claude session the plan belongs to. The harness hands it
 *   the prompt with the user's next message in its chat, and follows its
 *   progress on the task board as it reports each task.
 * - `elsewhere` — the user took the prompt to run somewhere the harness
 *   cannot see. The plan is locked all the same, but nothing reports back.
 */
export const BUILD_TARGETS = ['session', 'elsewhere'] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

/**
 * How much of the build harness a plan takes, chosen when it is submitted;
 * the repository's default is `mode` in `.coplan/config.json` (Managed
 * when it sets `iric`, else Tracked).
 *
 * - `export` — the user copies the plan out as Markdown, to build anywhere.
 *   Nothing is asked of an agent: no board, no gates. Submitting it locks
 *   a snapshot (the `elsewhere` target); exporting needs no sign-off.
 * - `tracked` — this session builds it its own way and reports each task.
 *   The board follows; what Managed would refuse comes back as a note.
 * - `managed` — each task goes implement → review → refine with the
 *   repository's checks, and the daemon holds a task back until it passes.
 */
export const EXECUTION_MODES = ['export', 'tracked', 'managed'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * How the build runs, chosen by the user when they submit — the control they
 * keep over each task's implement → review → refine cycle. Defaults come from
 * the repository's `.coplan/config.json`.
 */
export interface BuildSettings {
  /** Who reviews a task that does not say otherwise. */
  review: ReviewMode;
  /** How many ready tasks may be built at once, each by its own subagent.
   *  1 builds one task at a time. */
  parallel: number;
  /** Review rounds a task may take before Claude stops and asks the user. */
  maxRounds: number;
}

/**
 * The user's sign-off on the plan. From then on the design is final: the
 * plan is locked, and the harness's only job is to show the build moving
 * across the task board.
 */
export interface Submission {
  at: number;
  /** The change log's position when it was submitted: what the prompt
   *  knows about. Absent on plans submitted before it was recorded. */
  seq?: number;
  target: BuildTarget;
  /** Anything the user added for Claude when submitting. */
  note?: string;
  /** The prompt, exactly as the user previewed it before submitting. */
  prompt: string;
  /** The plan was too long to quote whole in a prompt; it points Claude at
   *  `harness_plan_read` for the rest. */
  trimmed?: boolean;
  /** How much of the harness the build takes. Absent on plans submitted
   *  before modes existed: those were Managed (or, built elsewhere, Export). */
  mode?: ExecutionMode;
  /** How the build runs: a Managed build's review, parallel and round
   *  settings. Absent on plans submitted before it existed. */
  settings?: BuildSettings;
  /** The repository's base branch when it was submitted, if it says. */
  base?: string;
  /** Given in the agent's chat rather than in Coplan: the user told the
   *  agent to go ahead, and it recorded that with `harness_plan_advance`. */
  via?: SignoffVia;
  /** What the user said in chat, as the agent quoted it. */
  userSaid?: string;
  /** When the prompt reached Claude. Null until the user's next message in
   *  Claude's chat carries it — and always null for `elsewhere`. */
  deliveredAt: number | null;
}

/**
 * Where a sign-off was given. Absent is the page's dialogs; `chat` is the
 * user saying so in the agent's chat, which the agent records with
 * `harness_plan_advance`, quoting them (#65).
 */
export type SignoffVia = 'chat';

/**
 * How the user last chose to have the plan built, in the Submit dialog —
 * kept on the session, so a go-ahead in chat builds it the way they last
 * chose, and the dialog opens on it.
 */
export interface BuildChoice {
  mode: ExecutionMode;
  /** A Managed build's settings, when the user set them. */
  settings?: BuildSettings;
  at: number;
}

/**
 * The user's sign-off on the design — the architecture, the sections and the
 * tasks planned on the diagram — before the task list is made from it. From
 * then on the design is locked and only the task breakdown moves: Claude
 * turns the planned tasks into a linked task list (what blocks what, which
 * branch each lands on), the user shapes that, and then submits it.
 */
export interface DesignSignoff {
  at: number;
  /** The change log's position when it was confirmed: what the prompt
   *  knows about. */
  seq?: number;
  note?: string;
  /** The prompt asking Claude for the task list, as the user previewed it. */
  prompt: string;
  trimmed?: boolean;
  /** Confirmed in the agent's chat, on the user's word (see `Submission`). */
  via?: SignoffVia;
  userSaid?: string;
  /** When the prompt reached Claude, with the user's next message. */
  deliveredAt: number | null;
}

/** What Claude wrote once the build was done: what was built, on which
 *  branches, how it was checked, and what was left. */
export interface BuildReport {
  text: string;
  at: number;
  /** The final checks, as they came out when the report was written. */
  checks?: CheckResult[];
}

export const PR_STATES = ['draft', 'open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

/** One branch of the build, as the agent reports it. */
export interface BranchState {
  /** Its pull request: the link, the number, and where it stands. */
  pr?: { url?: string; number?: number; state: PrState };
  /** The branch its pull request targets now — after a lower one merged,
   *  the base branch rather than the one it was stacked on. */
  base?: string;
  updatedAt: number;
}

/**
 * Where a plan is in its life, derived from its sign-offs and its tasks:
 * being designed, being broken into a task list once the design is
 * confirmed, handed over and waiting for Claude to pick it up, being built,
 * built, or handed to something outside the harness.
 */
export const PLAN_PHASES = ['planning', 'tasking', 'submitted', 'building', 'finalizing', 'built', 'handed-off'] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

/**
 * The four statuses a user sees, the same in the header, the session list
 * and the strip under the header (#66). The phases above are the detail
 * under them:
 *
 * - `planning` — `planning`, `tasking`: the design and the task list.
 * - `in_progress` — `submitted`, `building`: handed over, being built.
 * - `review` — `finalizing`, and a Managed build with a task waiting on the
 *   user's own review: what was built waits on the user.
 * - `done` — `built`, `handed-off`.
 */
export const PLAN_STATUSES = ['planning', 'in_progress', 'review', 'done'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface Plan {
  title: string;
  /** Markdown: the one-paragraph version of the whole plan. */
  summary: string;
  sections: Section[];
  diagrams: Diagram[];
  tasks: Task[];
  threads: Thread[];
  /** Newest last; bounded. */
  changes: Change[];
  /** The last `seq` handed out. */
  seq: number;
  /** Bumped on every saved change, layout included. `seq` only counts
   *  changes worth logging, so this is what orders two versions of a plan —
   *  a page uses it to never roll back to an older one. */
  version: number;
  /** The last `seq` Claude has read. Changes after it are unread by Claude. */
  claudeReadSeq: number;
  claudeReadAt: number | null;
  /** The plan's content as of that read, without layout. "Since you last
   *  read" is the difference between this and now — the net effect of the
   *  user's edits, not every step they took to get there. Daemon-side only:
   *  never sent to the browser. */
  claudeBaseline?: PlanBaseline;
  /** Set once the user confirms the design. While it is set the design is
   *  locked — only the tasks, their links to boxes and comments change. */
  design?: DesignSignoff;
  /** Set once the user submits the plan to be built. While it is set the
   *  plan is locked: the user changes nothing, and Claude only tracks tasks
   *  and replies to comments. */
  submission?: Submission;
  /** Claude's final report on the build. */
  report?: BuildReport;
  /** What the build has done with each of its branches: the pull request
   *  opened for it and where that stands, as the agent reports it. */
  branches?: Record<string, BranchState>;
  /** Changes Claude suggested, open and settled; newest last, bounded. */
  proposals?: Proposal[];
  /** The user's requests to revise the plan per their open comments:
   *  newest last, bounded, at most one waiting to be sent (#67). */
  revisions?: RevisionRequest[];
  /** Bumped each time Claude publishes the plan wholesale. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** A plan's content with everything that is only presentation left out:
 *  positions, revisions, timestamps, who touched what. */
export interface PlanBaseline {
  title: string;
  summary: string;
  sections: Pick<Section, 'id' | 'title' | 'body'>[];
  diagrams: (Pick<Diagram, 'id' | 'title' | 'caption' | 'edges'> & { nodes: Omit<DiagramNode, 'x' | 'y'>[] })[];
  tasks: Pick<Task, 'id' | 'parentId' | 'order' | 'title' | 'detail' | 'status' | 'files' | 'note' | 'dependsOn' | 'branch' | 'review' | 'addChecks' | 'skipChecks'>[];
}

/* ------------------------------------------------------------------ *
 * Edits
 * ------------------------------------------------------------------ */

/** A task as written by Claude when publishing: nested, ids optional. */
export interface TaskInput {
  id?: string;
  title: string;
  detail?: string;
  status?: TaskStatus;
  files?: string[];
  note?: string;
  /** Ids of tasks that must be done first. */
  dependsOn?: string[];
  branch?: string;
  review?: ReviewMode;
  /** Boxes this task builds: a node id, or `diagramId/nodeId` when the id
   *  is used in more than one diagram. Adds the task to each box. */
  builds?: string[];
  subtasks?: TaskInput[];
}

/** The task list for a confirmed design, as Claude publishes it. */
export interface TaskListInput {
  tasks: TaskInput[];
}

/** The whole plan, as Claude publishes it. Replaces the plan's content while
 *  keeping comments and statuses on every item whose id survives. */
export interface PlanInput {
  title: string;
  summary?: string;
  sections?: { id?: string; title: string; body: string }[];
  diagrams?: DiagramInput[];
  tasks?: TaskInput[];
}

/**
 * One edit to the plan. The UI and Claude speak the same operations, so the
 * change log is written in exactly one place no matter who made the change.
 */
export type PlanOp =
  | { op: 'set_meta'; title?: string; summary?: string }
  | {
      op: 'upsert_section';
      id?: string;
      title?: string;
      body?: string;
      index?: number;
      /** The revision the edit was made against. Refused if it moved on. */
      expect?: number;
    }
  | {
      op: 'upsert_diagram';
      id?: string;
      title?: string;
      /** When given, replaces the diagram's nodes (positions are kept for
       *  nodes that keep their id and omit x/y). */
      nodes?: DiagramNodeInput[];
      /** When given, replaces the diagram's edges. */
      edges?: DiagramEdgeInput[];
      direction?: DiagramDirection;
      caption?: string;
      index?: number;
      /** The revision the edit was made against. Refused if it moved on. */
      expect?: number;
    }
  | {
      op: 'upsert_task';
      id?: string;
      /** Only read on create; use `move_task` to re-parent. */
      parentId?: string | null;
      index?: number;
      title?: string;
      detail?: string;
      status?: TaskStatus;
      files?: string[];
      note?: string;
      /** Replaces the task's dependencies; `[]` clears them. */
      dependsOn?: string[];
      /** `""` clears it, so the task inherits its parent's. */
      branch?: string;
      /** `""` clears it, so the task inherits its parent's or the default. */
      review?: ReviewMode | '';
      stage?: IricStage;
      checks?: CheckResult[];
      /** The commit the task's work began at, as the daemon read it when the
       *  task started: progress, never set by hand. */
      startCommit?: string;
      /** The boxes this task builds now: replaces its links; [] unlinks it. */
      builds?: string[];
      /** The task's `rev` the edit was made against. Refused if the other
       *  side has changed the task since. */
      expect?: number;
      /** The page's note editor: the note it started from. Refused if the
       *  note changed since — a progress note moves no revision. */
      noteWas?: string;
    }
  | { op: 'move_task'; id: string; parentId: string | null; index: number }
  | { op: 'move_section'; id: string; index: number }
  | { op: 'move_diagram'; id: string; index: number }
  /** One box: changed (only the fields given) or added. */
  | {
      op: 'upsert_node';
      diagramId: string;
      id: string;
      label?: string;
      kind?: string;
      detail?: string;
      description?: string;
      notes?: string;
      taskIds?: string[];
      expect?: number;
    }
  /** One box, and the arrows to and from it. */
  | { op: 'remove_node'; diagramId: string; id: string; expect?: number }
  /** One arrow: changed by id (only the fields given), or added from → to. */
  | {
      op: 'upsert_edge';
      diagramId: string;
      id?: string;
      from?: string;
      to?: string;
      label?: string;
      dashed?: boolean;
      arrows?: string;
      expect?: number;
    }
  /** One arrow, by id or by its ends. */
  | { op: 'remove_edge'; diagramId: string; id?: string; from?: string; to?: string; expect?: number }
  | { op: 'remove'; kind: 'section' | 'diagram' | 'task'; id: string }
  /** A review's verdict on a task, for its current round: the user's from
   *  Coplan, or the agent's through harness_task_update. */
  | { op: 'review_task'; id: string; verdict: Verdict; summary?: string; userApproved?: boolean }
  /** Which checks one task runs, besides the repository's (#54): `add`
   *  replaces the checks it adds, `skip` the repository checks it leaves
   *  out ([] clears either). The user's alone — the agent proposes it. */
  | { op: 'set_checks'; id: string; add?: (Partial<TaskCheck> & { run: string })[]; skip?: string[] }
  | { op: 'comment'; target: Target; text: string }
  | { op: 'reply'; threadId: string; text: string }
  | { op: 'resolve'; threadId: string; resolved: boolean }
  /** The final report on the build. Markdown; replaces any earlier one.
   *  `checks`: the final checks, as they came out. */
  | { op: 'report'; text: string; checks?: CheckResult[] }
  /** What became of one of the build's branches (harness_branch_update). */
  | { op: 'set_branch'; branch: string; pr?: { url?: string; number?: number; state: string }; base?: string }
  /** Claude suggests a batch of edits, for the user to accept or reject. */
  | { op: 'propose'; title: string; reason: string; ops: PlanOp[] }
  /** The user takes a proposal: its edits apply, as theirs. */
  | { op: 'accept_proposal'; id: string }
  /** The user turns a proposal down, saying why if they like. */
  | { op: 'reject_proposal'; id: string; note?: string }
  /** Claude takes back a proposal it no longer stands by. */
  | { op: 'withdraw_proposal'; id: string };

export type PlanOpName = PlanOp['op'];

export const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'withdrawn'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * A change Claude suggests rather than makes: a batch of edits held until
 * the user accepts it (and it applies, as theirs) or rejects it. Its
 * reasoning is a comment thread, so the user can answer it there.
 */
export interface Proposal {
  /** `p1`, `p2`, …: never reused in a plan. */
  id: string;
  title: string;
  reason: string;
  ops: PlanOp[];
  /** The thread that carries the reasoning, and the outcome as a reply. */
  threadId: string;
  createdAt: number;
  /** Each item the edits touch (`kind:id`), as it was when proposed: a
   *  fingerprint of what it said (layout, task links and progress left
   *  out), or 0 if it did not exist. If any moves, the proposal is out of
   *  date and cannot be accepted — it was made for a plan that is gone. */
  base: Record<string, number | string>;
  status: ProposalStatus;
  resolvedAt?: number;
  /** The change-log `seq` of the answer: Claude has heard it once its read
   *  position passes this. */
  resolvedSeq?: number;
  /** The user's reason for turning it down. */
  note?: string;
}

/**
 * The user asks, from the page, for the plan to be revised per their open
 * comments: one explicit ask, queued like a sign-off and carried to the
 * agent with their next message in chat — Coplan never starts a turn
 * (#67). Each request is pending until it is sent, sent until every
 * comment it carries has an answer, then answered (`revisionStatus`).
 */
export interface RevisionRequest {
  /** `r1`, `r2`, …: never reused in a plan. */
  id: string;
  at: number;
  /** What the user added to the ask, if anything. */
  note?: string;
  /** The comment threads it carries: those waiting on the agent when it
   *  was queued. */
  threadIds: string[];
  /** The ask, exactly as the user previewed it and the agent gets it. */
  prompt: string;
  /** Too many comments to quote whole: the rest are pointed to. */
  trimmed?: boolean;
  /** When it reached the agent; null while it waits for the next message. */
  deliveredAt: number | null;
}

export const REVISION_STATUSES = ['pending', 'sent', 'answered'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

/**
 * Claude has stopped and needs something from the user: an answer to a
 * question it asked, a permission decision, or simply a reply. Captured from
 * hooks, shown in the harness, and answered in Claude itself — the harness
 * links there and never answers on the user's behalf.
 */
export interface WaitingState {
  kind: 'question' | 'permission' | 'input';
  /** The question, or what the prompt says, in one or two lines. */
  text: string;
  /** For `AskUserQuestion`: each question with its choices, read-only here. */
  questions?: { header?: string; question: string; options: string[]; multiSelect?: boolean }[];
  since: number;
}

/** Where the session runs, which decides how to open it. */
export type SessionSurface = 'cloud' | 'desktop' | 'cli' | 'unknown';

/** Two ways to the same session: the agent's desktop app, and the web. */
export interface SessionLink {
  /** Opens the session in the agent's app: `claude://claude.ai/code/session_…`
   *  for Claude, `codex://threads/…` for Codex. */
  app: string;
  /** `https://claude.ai/code/session_…` — works anywhere you are signed in.
   *  Null when the session has no web address (a local Codex thread). */
  web: string | null;
  /** How the session became addressable. */
  via: 'cloud' | 'remote-control' | 'app';
}

export interface SessionState {
  sessionId: string;
  /** The coding agent the session runs in. Sessions saved before Coplan
   *  supported more than Claude Code read back as `claude`. */
  agent: AgentKind;
  /** pid of the owning agent process (`claude`, `codex`, …), when known. */
  claudePid?: number;
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  title: string;
  /** Set once the user renames the session, so nothing overwrites it. */
  titleLocked?: boolean;
  /** Saved by a newer Coplan, in a format this build cannot read: served
   *  blank, and never saved over (so never on disk with this set). */
  savedByNewer?: boolean;
  status: SessionStatus;
  /** Set while Claude is waiting on the user; cleared when they reply. */
  waiting: WaitingState | null;
  surface: SessionSurface;
  /** Opens this session in its agent, where questions are answered. Null
   *  when the session cannot be addressed from outside: a local Claude
   *  session without Remote Control, or any Cursor chat, has no documented
   *  link. */
  link: SessionLink | null;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** When the session first used Coplan: `/coplan` (or `$coplan`) typed,
   *  the skill loaded, or one of its tools called. Every session with the
   *  plugin registers, but only these are the user's plans. */
  engagedAt?: number;
  /** How the user last chose to have a plan built here (the Submit dialog). */
  buildChoice?: BuildChoice;
  /** When the first of its hooks reached Coplan; null while none has — a
   *  session known only from its tool calls, whose agent is not running
   *  Coplan's hooks (in Codex: not trusted, or changed by an update and not
   *  trusted again). Absent on sessions saved before it was recorded. */
  hookedAt?: number | null;
  plan: Plan | null;
}

export interface TaskCounts {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
}

/** Compact row for the session rail. */
export interface SessionSummary {
  sessionId: string;
  agent: AgentKind;
  title: string;
  planTitle: string | null;
  cwd: string;
  repoName: string | null;
  repoRoot: string | null;
  branch: string | null;
  status: SessionStatus;
  /** The rail orders on this so rows hold still under the cursor. */
  createdAt: number;
  updatedAt: number;
  tasks: TaskCounts;
  /** Where the plan is in its life, in detail. */
  phase: PlanPhase;
  /** The status the session list shows and filters on (see `planStatus`). */
  planStatus: PlanStatus;
  /** Tasks a Managed build holds for the user's own review. */
  awaitingReview: number;
  /** The task Claude is on, for the rail. */
  current: string | null;
  waiting: WaitingState | null;
  surface: SessionSurface;
  link: SessionLink | null;
  openThreads: number;
  /** Items the user changed that Claude has not read yet. */
  unreadByClaude: number;
  /** The session has used Coplan (see `SessionState.engagedAt`), or has a
   *  plan. Only these are listed in the rail. */
  engaged: boolean;
  /** At least one of its hooks has reached Coplan (see `hookedAt`). */
  hooked: boolean;
  /** Saved by a newer Coplan (see `SessionState.savedByNewer`). */
  savedByNewer?: boolean;
}

/* ------------------------------------------------------------------ *
 * Server-sent events
 * ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'snapshot'; session: SessionState }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'ping'; ts: number }
  /** A session's state could not be written to disk: edits are not saved. */
  | { type: 'persist-error'; sessionId: string; message: string }
  /** What is wrong with the settings files this page's session reads
   *  (config.json, its repository's .claude/harness.json) now: every error,
   *  each naming its file. Empty once they are fixed. `files` are the files
   *  it speaks for. */
  | { type: 'config-errors'; errors: string[]; files: string[] };

/* ------------------------------------------------------------------ *
 * Daemon lock file
 * ------------------------------------------------------------------ */

export interface DaemonLock {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: number;
  host: string;
}

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

/** The kinds of reclaimable file the harness knows how to describe. */
export const CLEANUP_GROUPS = ['sessions', 'partial-writes', 'log', 'lock'] as const;
export type CleanupGroupId = (typeof CLEANUP_GROUPS)[number];

export interface StorageGroup {
  id: CleanupGroupId;
  /** Names the thing being lost, not the mechanism that leaves it behind. */
  label: string;
  detail: string;
  count: number;
  bytes: number;
}

export interface StorageReport {
  home: string;
  scannedAt: number;
  groups: StorageGroup[];
  totalBytes: number;
}

export interface CleanupOutcome {
  dryRun: boolean;
  groups: { id: CleanupGroupId; label: string; count: number; bytes: number }[];
  removed: number;
  freedBytes: number;
  /** Paths the harness was not allowed to remove. */
  failed: string[];
}
