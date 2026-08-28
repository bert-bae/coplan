/**
 * Shared vocabulary for every process in the harness: the daemon, the MCP
 * server, the hook relay and the browser UI all speak these types.
 */

export const STAGES = [
  'idle',
  'planning',
  'plan_review',
  'implementing',
  'code_review',
  'verification',
  'ship',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

/** What the session is doing right now, as far as the harness can tell. */
export type SessionStatus =
  | 'active' /** a turn is in flight */
  | 'waiting' /** parked on a gate, waiting for the user */
  | 'idle' /** turn ended, no gate open */
  | 'ended';

export type GateKind = 'plan' | 'code_review' | 'verification' | 'ship' | 'question';

export type Verdict = 'approved' | 'changes_requested' | 'rejected' | 'answered';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  /** User-authored note attached to this step during plan review. */
  comment?: string;
  status?: 'pending' | 'active' | 'done' | 'dropped';
}

export interface Plan {
  title: string;
  summary?: string;
  steps: PlanStep[];
  /** Raw markdown, when the model published prose instead of steps. */
  markdown?: string;
  revision: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Task board
 * ------------------------------------------------------------------ */

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskNoteKind = 'change' | 'decision' | 'blocker' | 'note';

/** A line of the agent's working record for one task. */
export interface TaskNote {
  id: string;
  ts: number;
  kind: TaskNoteKind;
  text: string;
}

/** Something the agent did not know, asked about, and got an answer to. The
 *  daemon records these automatically when a blocking question resolves, so
 *  the reasoning behind a change survives the session. */
export interface TaskDecision {
  id: string;
  ts: number;
  question: string;
  answer: string;
  /** What the agent did with the answer. */
  rationale?: string;
}

export interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  /** The plan step this was derived from, when it came from one. */
  planStepId?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** The agent's record of what it actually changed. */
  notes: TaskNote[];
  /** Files edited while this task was in progress — attributed by the daemon
   *  from hook events, so it costs no tokens and cannot be misreported. */
  files: string[];
  /** Open question holding this task up. */
  blockedBy?: string;
  blockedReason?: string;
  decisions: TaskDecision[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TouchedFile {
  path: string;
  edits: number;
  firstTouchedAt: number;
  lastTouchedAt: number;
  tools: string[];
}

export interface CommandRun {
  id: string;
  command: string;
  description?: string;
  startedAt: number;
  ok: boolean;
  /** Truncated head of the output, purely for the timeline. */
  preview?: string;
}

export type TimelineKind =
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'stage'
  | 'note'
  | 'user'
  | 'feedback'
  | 'notification'
  | 'gate'
  | 'check'
  | 'ship'
  | 'error';

export interface TimelineEvent {
  id: string;
  ts: number;
  kind: TimelineKind;
  /** Short label, e.g. a tool name or stage name. */
  label?: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface ThreadReply {
  id: string;
  ts: number;
  author: 'user' | 'claude';
  text: string;
}

/** A comment thread anchored to a line range of a diff. */
export interface ReviewThread {
  id: string;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  body: string;
  /** Verbatim source lines the user selected, so Claude sees what they meant. */
  excerpt?: string;
  createdAt: number;
  resolved: boolean;
  /** Set once the thread has been handed to Claude. */
  deliveredAt?: number;
  /** Review round it was written in. Lets the UI separate "this round" from
   *  comments Claude has already had a chance to address. */
  round?: number;
  /** The back-and-forth on this comment. Without it, Claude's answer lands in
   *  the activity feed as prose the reader has to correlate by hand. */
  replies?: ThreadReply[];
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Omitted when the file is too large to render; the UI shows a stub. */
  hunks?: DiffHunk[];
  truncated?: boolean;
  /** False when this file has not changed since the reviewer last looked.
   *  Undefined on the first round, when everything is new. */
  changedSinceLastReview?: boolean;
}

/** What the working tree looked like at the end of one review round. */
export interface ReviewRoundSnapshot {
  round: number;
  at: number;
  baseRef: string;
  headRef: string;
  /** Content hash per path, so "changed since you looked" survives commits,
   *  amends and rebases — comparing SHAs alone would not. */
  fingerprints: Record<string, string>;
}

export interface DiffPayload {
  baseRef: string;
  headRef: string;
  branch: string | null;
  generatedAt: number;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Files changed in the working tree but not yet committed. */
  includesWorkingTree: boolean;
  round: number;
  /** Set once there is an earlier round to compare against. */
  previousRound?: number;
  /** Paths that changed since the previous round. */
  changedSinceLastReview?: string[];
}

export interface CheckRun {
  id: string;
  command: string;
  label?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Ring-buffered tail of combined stdout/stderr. */
  output: string;
}

export interface ShipProviderCommand {
  kind: 'command';
  label?: string;
  /** Supports {{title}}, {{body}}, {{bodyFile}}, {{branch}}, {{base}}. */
  command: string;
}

export interface ShipProviderMcp {
  kind: 'mcp';
  label?: string;
  /** Instruction handed back to the model, which performs the MCP call. */
  directive: string;
}

export interface ShipProviderNone {
  kind: 'none';
  label?: string;
}

export type ShipProvider = ShipProviderCommand | ShipProviderMcp | ShipProviderNone;

export type ShipStep = 'checks' | 'commit' | 'push' | 'pr' | 'summary';

export interface ShipState {
  title: string;
  body: string;
  commitMessage: string;
  branch: string | null;
  baseBranch: string | null;
  steps: ShipStep[];
  provider: string;
  /** Filled in after the ship action runs. */
  result?: {
    ok: boolean;
    output: string;
    url?: string;
    summaryPath?: string;
  };
}

export interface GateResult {
  verdict: Verdict;
  comment?: string;
  /** Plan review: the user's edited step list. */
  steps?: PlanStep[];
  /** Code review: line-anchored comments. */
  threads?: ReviewThread[];
  /** Ship: the user's confirmed configuration, plus what the daemon did with
   *  it. `directive` is set when the chosen provider is an MCP server, which
   *  only the session can call — Claude performs that step itself. */
  ship?: Pick<ShipState, 'title' | 'body' | 'commitMessage' | 'steps' | 'provider'> & {
    branch?: string | null;
    baseBranch?: string | null;
    directive?: string;
    outcome?: { ok: boolean; output: string; url?: string; summaryPath?: string };
  };
  /** Free-form answers for `question` gates. */
  answers?: Record<string, string>;
  resolvedAt: number;
}

export interface GateOptions {
  /** `question` gates: suggested answers, rendered as one-click buttons. */
  options?: string[];
}

export interface Gate {
  id: string;
  kind: GateKind;
  stage: Stage;
  prompt: string;
  createdAt: number;
  /** Kind-specific extras the UI needs to render the gate. */
  meta?: GateOptions;
  status: 'open' | 'resolved' | 'cancelled';
  result?: GateResult;
  /** Set when the model is actively parked on this gate. */
  waiting: boolean;
  /** When the verdict was handed to Claude. A gate can be resolved before
   *  Claude's turn ends, so "resolved" alone does not mean "delivered". */
  deliveredAt?: number;
}

/** An async comment queued while Claude was working; drained at a turn boundary. */
export interface FeedbackItem {
  id: string;
  createdAt: number;
  text: string;
  /** Where in the UI it came from, for rendering it back with context. */
  origin: 'timeline' | 'plan' | 'diff' | 'checks' | 'ship';
  threads?: ReviewThread[];
}

export interface SessionState {
  sessionId: string;
  /** pid of the owning `claude` process, when known. */
  claudePid?: number;
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  transcriptPath: string | null;
  title: string;
  stage: Stage;
  stageNote?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  baseRef: string | null;
  /** Commit the session started from, used as a diff base fallback. */
  startCommit: string | null;
  /** Incremented every time Claude publishes a diff for review. */
  reviewRound: number;
  /** One entry per completed round, for "what changed since I last looked". */
  roundHistory: ReviewRoundSnapshot[];
  tasks: Task[];
  /** Rolled up from the transcript; shown per stage in the UI. */
  usage?: { inputTokens: number; outputTokens: number; byStage: Record<string, number> };
  plan: Plan | null;
  todos: TodoItem[];
  files: TouchedFile[];
  commands: CommandRun[];
  timeline: TimelineEvent[];
  gates: Gate[];
  activeGateId: string | null;
  threads: ReviewThread[];
  checks: CheckRun[];
  ship: ShipState | null;
  pendingFeedback: FeedbackItem[];
  /** Counters surfaced in the UI header. */
  stats: {
    turns: number;
    toolCalls: number;
    edits: number;
  };
}

/** Compact row for the session switcher. */
export interface SessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  repoName: string | null;
  branch: string | null;
  stage: Stage;
  status: SessionStatus;
  updatedAt: number;
  openGates: number;
  pendingFeedback: number;
  tasks: { total: number; done: number; blocked: number };
}

/* ------------------------------------------------------------------ *
 * Server-sent events
 * ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'snapshot'; session: SessionState }
  | { type: 'state'; sessionId: string; patch: Partial<SessionState> }
  | { type: 'timeline'; sessionId: string; events: TimelineEvent[] }
  | { type: 'diff'; sessionId: string; diff: DiffPayload }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'check'; sessionId: string; check: CheckRun }
  | { type: 'tasks'; sessionId: string; tasks: Task[] }
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
