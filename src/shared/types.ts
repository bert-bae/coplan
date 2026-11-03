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

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Dashed for optional, async or future connections. */
  dashed?: boolean;
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
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Which way automatic layout flows. */
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
  /** The last `seq` Claude has read. Changes after it are unread by Claude. */
  claudeReadSeq: number;
  claudeReadAt: number | null;
  /** Bumped each time Claude publishes the plan wholesale. */
  revision: number;
  createdAt: number;
  updatedAt: number;
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
  subtasks?: TaskInput[];
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
  | { op: 'upsert_section'; id?: string; title?: string; body?: string; index?: number }
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
    }
  | { op: 'move_task'; id: string; parentId: string | null; index: number }
  | { op: 'move_section'; id: string; index: number }
  | { op: 'move_diagram'; id: string; index: number }
  | { op: 'remove'; kind: Exclude<TargetKind, 'plan'>; id: string }
  | { op: 'comment'; target: Target; text: string }
  | { op: 'reply'; threadId: string; text: string }
  | { op: 'resolve'; threadId: string; resolved: boolean };

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
  /** The task Claude is on, for the rail. */
  current: string | null;
  waiting: WaitingState | null;
  surface: SessionSurface;
  link: SessionLink | null;
  openThreads: number;
  /** User changes Claude has not read yet. */
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
