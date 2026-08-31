import type { Gate, GateKind, SessionState, TimelineEvent } from '../../shared/types.ts';
import type { Tab } from '../store.ts';

/**
 * What each stage of the pipeline is doing, in the user's terms.
 *
 * The daemon already records everything needed to answer "did I approve this,
 * and what happened next" — a resolved gate keeps its verdict forever — but
 * nothing in the UI read it back, so an approved plan looked exactly like a
 * plan nobody had ever opened. This is the single place that turns the gate
 * history into the sentence a tab, a badge and a banner all show.
 */

export type StageTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export type StageState =
  | 'not_started' /** nothing has been published for this stage */
  | 'ready' /** there is something to read, but no verdict is being asked for */
  | 'awaiting' /** a gate is open here: the user has to act */
  | 'working' /** Claude is acting on what the user decided */
  | 'approved'
  | 'changes'
  | 'rejected'
  | 'skipped' /** the gate was closed by a message rather than a verdict */
  | 'done';

export interface StageStatus {
  state: StageState;
  /** Two or three words. Rendered as a chip, so it has to stand alone. */
  label: string;
  tone: StageTone;
  /** One line saying what that means for the reader right now. */
  detail: string;
  /** When the verdict landed, when the state came from one. */
  at?: number;
}

/** Which gate governs each tab. `board` is the only one that has none. */
export const GATE_FOR_TAB: Record<Tab, GateKind | null> = {
  timeline: 'question',
  plan: 'plan',
  board: null,
  review: 'code_review',
  verify: 'verification',
  ship: 'ship',
};

export function isWorking(session: SessionState | null): boolean {
  return session?.status === 'active';
}

/** The most recent gate of a kind, whatever became of it. */
export function lastGate(session: SessionState, kind: GateKind): Gate | null {
  for (let i = session.gates.length - 1; i >= 0; i--) {
    const gate = session.gates[i];
    if (gate?.kind === kind) return gate;
  }
  return null;
}

/** The most recent gate of a kind the user actually gave a verdict on. */
export function lastVerdict(session: SessionState, kind: GateKind): Gate | null {
  for (let i = session.gates.length - 1; i >= 0; i--) {
    const gate = session.gates[i];
    if (gate?.kind === kind && gate.status === 'resolved' && gate.result) return gate;
  }
  return null;
}

const VERDICT_LABEL: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  answered: 'Answered',
};

export function verdictLabel(verdict: string): string {
  return VERDICT_LABEL[verdict] ?? verdict;
}

export function stageStatus(session: SessionState, tab: Tab): StageStatus {
  if (tab === 'board') return boardStatus(session);
  const kind = GATE_FOR_TAB[tab];
  if (!kind) return { state: 'ready', label: '', tone: 'neutral', detail: '' };

  const gate = lastGate(session, kind);
  const working = isWorking(session);

  if (gate?.status === 'open') {
    return {
      state: 'awaiting',
      label: 'Waiting on you',
      tone: 'warning',
      at: gate.createdAt,
      detail: gate.waiting
        ? 'The terminal session is parked here and will not continue until you answer.'
        : 'Claude has gone idle with this open. Your answer reaches it the next time it runs.',
    };
  }

  if (gate?.status === 'cancelled') {
    return {
      state: 'skipped',
      label: 'Skipped',
      tone: 'neutral',
      at: gate.createdAt,
      detail: 'You sent a message instead of a verdict, so this gate was closed.',
    };
  }

  if (gate?.status === 'resolved' && gate.result) {
    const { verdict, resolvedAt } = gate.result;
    if (tab === 'ship' && session.ship?.result?.ok) {
      return {
        state: 'done',
        label: 'Shipped',
        tone: 'success',
        at: resolvedAt,
        detail: 'The ship steps ran and finished.',
      };
    }
    if (verdict === 'approved' || verdict === 'answered') {
      return {
        state: working ? 'working' : 'approved',
        label: verdictLabel(verdict),
        tone: 'success',
        at: resolvedAt,
        detail: working
          ? 'Claude is working on what comes next. Nothing is needed from you.'
          : 'Nothing more is needed here.',
      };
    }
    if (verdict === 'changes_requested') {
      return {
        state: working ? 'working' : 'changes',
        label: 'Changes requested',
        tone: 'warning',
        at: resolvedAt,
        detail: working
          ? 'Claude is working through your feedback. It comes back here when it has.'
          : 'Claude has your feedback and has not picked it up yet.',
      };
    }
    return {
      state: 'rejected',
      label: 'Rejected',
      tone: 'danger',
      at: resolvedAt,
      detail: 'You told Claude to stop and wait for direction.',
    };
  }

  return notStarted(session, tab);
}

function notStarted(session: SessionState, tab: Tab): StageStatus {
  switch (tab) {
    case 'plan':
      return session.plan
        ? {
            state: 'ready',
            label: 'Draft',
            tone: 'neutral',
            detail: 'A plan is published but no review has been asked for.',
          }
        : {
            state: 'not_started',
            label: 'Not started',
            tone: 'neutral',
            detail: 'No plan has been published yet.',
          };
    case 'review':
      return {
        state: 'not_started',
        label: 'Not started',
        tone: 'neutral',
        detail: 'No diff has been published for review yet.',
      };
    case 'verify':
      return session.checks.length
        ? {
            state: 'ready',
            label: 'Not signed off',
            tone: 'neutral',
            detail: 'Checks exist but no sign-off has been asked for.',
          }
        : {
            state: 'not_started',
            label: 'Not started',
            tone: 'neutral',
            detail: 'No checks have been run yet.',
          };
    case 'ship':
      return session.ship
        ? {
            state: 'ready',
            label: 'Not shipped',
            tone: 'neutral',
            detail: 'A ship is composed but has not been run.',
          }
        : {
            state: 'not_started',
            label: 'Not started',
            tone: 'neutral',
            detail: 'Nothing has been composed to ship yet.',
          };
    default:
      return { state: 'ready', label: '', tone: 'neutral', detail: '' };
  }
}

function boardStatus(session: SessionState): StageStatus {
  const tasks = session.tasks;
  if (tasks.length === 0) {
    return {
      state: 'not_started',
      label: 'No board',
      tone: 'neutral',
      detail: 'A board appears once a plan is approved.',
    };
  }
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  if (blocked > 0) {
    return {
      state: 'awaiting',
      label: 'Blocked',
      tone: 'warning',
      detail: `${blocked} card${blocked === 1 ? '' : 's'} blocked on a question from Claude.`,
    };
  }
  const done = tasks.filter((t) => t.status === 'done').length;
  if (done === tasks.length) {
    return {
      state: 'done',
      label: 'All done',
      tone: 'success',
      detail: `All ${tasks.length} cards are closed.`,
    };
  }
  return {
    state: isWorking(session) ? 'working' : 'ready',
    label: `${done}/${tasks.length} done`,
    tone: 'accent',
    detail: isWorking(session) ? 'Claude is working through the board.' : 'Work is part-finished.',
  };
}

/* ------------------------------------------------------------------ *
 * The choices a gate actually offers
 * ------------------------------------------------------------------ */

export interface GateChoice {
  /** Stable across renamings; a view keys its handler off this. */
  id: string;
  /** The exact words on the button that performs it. */
  label: string;
  /** What happens to the session if it is chosen. */
  effect: string;
  variant?: 'primary' | 'default' | 'danger';
}

/**
 * The complete set of things that move a session on from a gate.
 *
 * One table, read by both the banner — which lists the moves from whatever
 * tab the user is on — and the stage's own panel, which renders them as the
 * buttons. Two lists would drift, and a banner promising a move the tab does
 * not offer is worse than no banner at all.
 */
export function gateChoices(kind: GateKind): GateChoice[] {
  switch (kind) {
    case 'plan':
      return [
        {
          id: 'approve',
          label: 'Approve plan',
          effect: 'Claude starts building, and the plan becomes the task board',
          variant: 'primary',
        },
        { id: 'changes', label: 'Request changes', effect: 'Claude revises the plan and publishes it again' },
        { id: 'reject', label: 'Reject', effect: 'Claude stops and waits for direction', variant: 'danger' },
      ];
    case 'code_review':
      return [
        { id: 'approve', label: 'Approve', effect: 'Claude moves on to verification', variant: 'primary' },
        {
          id: 'changes',
          label: 'Request changes',
          effect: 'Claude addresses your comments and republishes the diff',
        },
      ];
    case 'verification':
      return [
        {
          id: 'approve',
          label: 'Looks verified',
          effect: 'Claude moves on to the ship stage',
          variant: 'primary',
        },
        { id: 'changes', label: 'Not ready', effect: 'Claude keeps working on the checks' },
      ];
    case 'ship':
      return [
        {
          id: 'ship',
          label: 'Ship…',
          effect: 'Runs the selected steps against your working tree, after one more confirmation',
          variant: 'primary',
        },
        {
          id: 'decline',
          label: "Don't ship",
          effect: 'Claude stops here and waits for direction instead of pushing',
        },
      ];
    case 'question':
      return [
        { id: 'answer', label: 'Send answer', effect: 'Claude carries on with your answer', variant: 'primary' },
      ];
  }
}

/** The gate's name in a sentence. */
export function gateName(kind: GateKind): string {
  switch (kind) {
    case 'plan':
      return 'plan';
    case 'code_review':
      return 'code review';
    case 'verification':
      return 'verification';
    case 'ship':
      return 'ship';
    case 'question':
      return 'question';
  }
}

/* ------------------------------------------------------------------ *
 * What Claude is doing right now
 * ------------------------------------------------------------------ */

const ACTIVITY_KINDS = new Set<TimelineEvent['kind']>(['tool', 'assistant', 'thinking', 'stage', 'check']);

/**
 * A short phrase for the current action, taken from the last thing the
 * transcript recorded. "Working" alone is true but useless; the reader wants
 * to know whether it is reading, editing or running something.
 */
export function currentActivity(session: SessionState): string | null {
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const event = session.timeline[i];
    if (!event || !ACTIVITY_KINDS.has(event.kind)) continue;
    if (event.kind === 'tool') return event.label ? `running ${event.label}` : 'running a tool';
    if (event.kind === 'thinking') return 'thinking';
    if (event.kind === 'check') return 'running checks';
    if (event.kind === 'stage') return event.label ? `entering ${event.label.replace('_', ' ')}` : null;
    return firstLine(event.text);
  }
  return null;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const trimmed = line.trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 88)}…` : trimmed;
}
