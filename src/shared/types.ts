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
 */

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

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
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
  createdAt: number;
  updatedAt: number;
  createdBy: Author;
}

/** What a comment is attached to. `plan` targets the plan as a whole. */
export const TARGET_KINDS = ['plan', 'section', 'diagram', 'task'] as const;
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
  target: BuildTarget;
  /** Anything the user added for Claude when submitting. */
  note?: string;
  /** The prompt, exactly as the user previewed it before submitting. */
  prompt: string;
  /** The plan was too long to quote whole in a prompt; it points Claude at
   *  `harness_plan_read` for the rest. */
  trimmed?: boolean;
  /** How the build runs. Absent on plans submitted before it existed. */
  settings?: BuildSettings;
  /** When the prompt reached Claude. Null until the user's next message in
   *  Claude's chat carries it — and always null for `elsewhere`. */
  deliveredAt: number | null;
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
  note?: string;
  /** The prompt asking Claude for the task list, as the user previewed it. */
  prompt: string;
  trimmed?: boolean;
  /** When the prompt reached Claude, with the user's next message. */
  deliveredAt: number | null;
}

/** What Claude wrote once the build was done: what was built, on which
 *  branches, how it was checked, and what was left. */
export interface BuildReport {
  text: string;
  at: number;
}

/**
 * Where a plan is in its life, derived from its sign-offs and its tasks:
 * being designed, being broken into a task list once the design is
 * confirmed, handed over and waiting for Claude to pick it up, being built,
 * built, or handed to something outside the harness.
 */
export type PlanPhase = 'planning' | 'tasking' | 'submitted' | 'building' | 'built' | 'handed-off';

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
  tasks: Pick<Task, 'id' | 'parentId' | 'order' | 'title' | 'detail' | 'status' | 'files' | 'note' | 'dependsOn' | 'branch' | 'review'>[];
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
      /** Boxes this task builds, added to each (see `TaskInput.builds`). */
      builds?: string[];
    }
  | { op: 'move_task'; id: string; parentId: string | null; index: number }
  | { op: 'move_section'; id: string; index: number }
  | { op: 'move_diagram'; id: string; index: number }
  | { op: 'remove'; kind: Exclude<TargetKind, 'plan'>; id: string }
  | { op: 'comment'; target: Target; text: string }
  | { op: 'reply'; threadId: string; text: string }
  | { op: 'resolve'; threadId: string; resolved: boolean }
  /** The final report on the build. Markdown; replaces any earlier one. */
  | { op: 'report'; text: string };

export type PlanOpName = PlanOp['op'];

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

/** Two ways to the same session: the Claude desktop app, and the web. */
export interface SessionLink {
  /** `claude://claude.ai/code/session_…` — opens the desktop app. */
  app: string;
  /** `https://claude.ai/code/session_…` — works anywhere you are signed in. */
  web: string;
  /** How the session became addressable. */
  via: 'cloud' | 'remote-control';
}

export interface SessionState {
  sessionId: string;
  /** pid of the owning `claude` process, when known. */
  claudePid?: number;
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  title: string;
  /** Set once the user renames the session, so nothing overwrites it. */
  titleLocked?: boolean;
  status: SessionStatus;
  /** Set while Claude is waiting on the user; cleared when they reply. */
  waiting: WaitingState | null;
  surface: SessionSurface;
  /** Opens this session in Claude, where questions are answered. Null when
   *  the session cannot be addressed from outside: a local session without
   *  Remote Control has no documented link. */
  link: SessionLink | null;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
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
  /** Planning, or submitted and being built. */
  phase: PlanPhase;
  /** The task Claude is on, for the rail. */
  current: string | null;
  waiting: WaitingState | null;
  surface: SessionSurface;
  link: SessionLink | null;
  openThreads: number;
  /** Items the user changed that Claude has not read yet. */
  unreadByClaude: number;
}

/* ------------------------------------------------------------------ *
 * Server-sent events
 * ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'snapshot'; session: SessionState }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'ping'; ts: number };

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
