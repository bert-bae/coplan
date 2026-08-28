import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths, ensureHome, sanitizeId } from '../shared/paths.ts';
import type {
  SessionState,
  SessionSummary,
  Stage,
  TimelineEvent,
  TimelineKind,
  ServerEvent,
  Gate,
  GateKind,
  GateOptions,
  GateResult,
  FeedbackItem,
  DiffPayload,
  ReviewThread,
} from '../shared/types.ts';

const PERSIST_DEBOUNCE_MS = 400;

export function newSession(sessionId: string, cwd: string): SessionState {
  const now = Date.now();
  return {
    sessionId,
    cwd,
    repoRoot: null,
    branch: null,
    transcriptPath: null,
    title: path.basename(cwd) || sessionId.slice(0, 8),
    stage: 'idle',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    baseRef: null,
    startCommit: null,
    reviewRound: 0,
    roundHistory: [],
    tasks: [],
    plan: null,
    todos: [],
    files: [],
    commands: [],
    timeline: [],
    gates: [],
    activeGateId: null,
    threads: [],
    checks: [],
    ship: null,
    pendingFeedback: [],
    stats: { turns: 0, toolCalls: 0, edits: 0 },
  };
}

/**
 * In-memory registry of every session the harness has seen, with
 * write-behind persistence and an SSE fan-out.
 */
export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private diffs = new Map<string, DiffPayload>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private maxTimeline: number;

  constructor(opts: { maxTimelineEvents?: number } = {}) {
    super();
    this.setMaxListeners(0);
    this.maxTimeline = opts.maxTimelineEvents ?? 500;
    ensureHome();
    this.loadFromDisk();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  private loadFromDisk(): void {
    const dir = paths.sessionsDir();
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'state.json');
      if (!existsSync(file)) continue;
      try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
        if (!state.sessionId) continue;
        // Sessions written by an older build predate some fields.
        state.reviewRound ??= 0;
        state.threads ??= [];
        state.roundHistory ??= [];
        state.tasks ??= [];
        // A session cannot still be mid-turn across a daemon restart.
        if (state.status === 'active') state.status = 'idle';
        // Any gate that was parked has lost its waiter.
        for (const gate of state.gates) gate.waiting = false;
        this.sessions.set(state.sessionId, state);
      } catch {
        /* skip unreadable session */
      }
    }
  }

  private persistSoon(id: string): void {
    const existing = this.persistTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.persistTimers.delete(id);
      this.persistNow(id);
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.persistTimers.set(id, timer);
  }

  persistNow(id: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    try {
      const dir = paths.sessionDir(id);
      mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.state.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, path.join(dir, 'state.json'));
    } catch {
      /* persistence is best-effort; the live session must never break */
    }
  }

  persistAll(): void {
    for (const id of this.sessions.keys()) this.persistNow(id);
  }

  /* ---------------------------------------------------------------- *
   * Access
   * ---------------------------------------------------------------- */

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /** Get or create. Sessions appear the moment any signal mentions them. */
  ensure(id: string, cwd?: string): SessionState {
    let state = this.sessions.get(id);
    if (!state) {
      state = newSession(id, cwd || process.cwd());
      this.sessions.set(id, state);
      mkdirSync(paths.sessionDir(id), { recursive: true });
      this.emitEvent({ type: 'snapshot', session: state });
      this.broadcastSessionList();
    } else if (cwd && state.cwd !== cwd && !state.repoRoot) {
      state.cwd = cwd;
    }
    return state;
  }

  all(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  summaries(): SessionSummary[] {
    return this.all().map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      cwd: s.cwd,
      repoName: s.repoRoot ? path.basename(s.repoRoot) : null,
      branch: s.branch,
      stage: s.stage,
      status: s.status,
      updatedAt: s.updatedAt,
      openGates: s.gates.filter((g) => g.status === 'open').length,
      pendingFeedback: s.pendingFeedback.length,
      tasks: {
        total: s.tasks.length,
        done: s.tasks.filter((t) => t.status === 'done').length,
        blocked: s.tasks.filter((t) => t.status === 'blocked').length,
      },
    }));
  }

  /** Most recently updated session rooted at (or under) `cwd`. */
  findByCwd(cwd: string): SessionState | undefined {
    const normalized = path.resolve(cwd);
    return this.all().find(
      (s) => path.resolve(s.cwd) === normalized || (s.repoRoot && path.resolve(s.repoRoot) === normalized),
    );
  }

  findByPid(pid: number): SessionState | undefined {
    return this.all().find((s) => s.claudePid === pid);
  }

  /* ---------------------------------------------------------------- *
   * Mutation
   * ---------------------------------------------------------------- */

  /** Apply a patch, persist, and push the delta to every connected client. */
  update(id: string, patch: Partial<SessionState>): SessionState | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    Object.assign(state, patch);
    state.updatedAt = Date.now();
    this.persistSoon(id);
    this.emitEvent({ type: 'state', sessionId: id, patch: { ...patch, updatedAt: state.updatedAt } });
    if (patch.stage || patch.status || patch.branch || patch.title) this.broadcastSessionList();
    return state;
  }

  /** Mutate in place with a callback, then broadcast the whole session. */
  mutate(id: string, fn: (s: SessionState) => void): SessionState | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    fn(state);
    state.updatedAt = Date.now();
    this.persistSoon(id);
    this.emitEvent({ type: 'snapshot', session: state });
    this.broadcastSessionList();
    return state;
  }

  addTimeline(
    id: string,
    kind: TimelineKind,
    text: string,
    opts: { label?: string; meta?: Record<string, unknown> } = {},
  ): TimelineEvent | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    const event: TimelineEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind,
      text,
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.meta ? { meta: opts.meta } : {}),
    };
    state.timeline.push(event);
    if (state.timeline.length > this.maxTimeline) {
      state.timeline.splice(0, state.timeline.length - this.maxTimeline);
    }
    state.updatedAt = event.ts;
    this.persistSoon(id);
    this.emitEvent({ type: 'timeline', sessionId: id, events: [event] });
    return event;
  }

  addTimelineBatch(id: string, events: Omit<TimelineEvent, 'id' | 'ts'>[], baseTs = Date.now()): void {
    if (events.length === 0) return;
    const state = this.sessions.get(id);
    if (!state) return;
    const made: TimelineEvent[] = events.map((e, i) => ({ id: randomUUID(), ts: baseTs + i, ...e }));
    state.timeline.push(...made);
    if (state.timeline.length > this.maxTimeline) {
      state.timeline.splice(0, state.timeline.length - this.maxTimeline);
    }
    state.updatedAt = Date.now();
    this.persistSoon(id);
    this.emitEvent({ type: 'timeline', sessionId: id, events: made });
  }

  setStage(id: string, stage: Stage, note?: string): void {
    const state = this.sessions.get(id);
    if (!state || state.stage === stage) {
      if (state && note) this.update(id, { stageNote: note });
      return;
    }
    this.update(id, { stage, stageNote: note });
    this.addTimeline(id, 'stage', note ? `${stage} — ${note}` : stage, { label: stage });
  }

  /* ---------------------------------------------------------------- *
   * Gates
   * ---------------------------------------------------------------- */

  openGate(id: string, kind: GateKind, prompt: string, meta?: GateOptions): Gate | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    // One open gate at a time keeps the UI unambiguous. Anything parked on
    // the old gate has to be told, or it holds the terminal for its full
    // window waiting on a gate that no longer exists.
    for (const g of state.gates) {
      if (g.status !== 'open') continue;
      g.status = 'cancelled';
      g.waiting = false;
      this.emit('gate:cancelled', { sessionId: id, gate: g });
    }
    const gate: Gate = {
      id: randomUUID(),
      kind,
      stage: state.stage,
      prompt,
      createdAt: Date.now(),
      status: 'open',
      waiting: false,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };
    state.gates.push(gate);
    state.activeGateId = gate.id;
    state.updatedAt = gate.createdAt;
    this.persistSoon(id);
    this.addTimeline(id, 'gate', prompt, { label: kind, meta: { gateId: gate.id } });
    this.emitEvent({ type: 'state', sessionId: id, patch: { gates: state.gates, activeGateId: gate.id } });
    this.broadcastSessionList();
    return gate;
  }

  getGate(id: string, gateId: string): Gate | undefined {
    return this.sessions.get(id)?.gates.find((g) => g.id === gateId);
  }

  activeGate(id: string): Gate | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    return state.gates.find((g) => g.id === state.activeGateId && g.status === 'open');
  }

  resolveGate(id: string, gateId: string, result: GateResult): Gate | undefined {
    const state = this.sessions.get(id);
    const gate = state?.gates.find((g) => g.id === gateId);
    if (!state || !gate || gate.status !== 'open') return undefined;
    gate.status = 'resolved';
    gate.result = result;
    gate.waiting = false;
    if (state.activeGateId === gateId) state.activeGateId = null;
    if (result.threads?.length) {
      const byId = new Map(state.threads.map((t) => [t.id, t]));
      for (const t of result.threads) byId.set(t.id, t);
      state.threads = [...byId.values()];
    }
    if (result.steps && state.plan) {
      state.plan = { ...state.plan, steps: result.steps, revision: state.plan.revision + 1, updatedAt: Date.now() };
    }
    state.updatedAt = Date.now();
    this.persistSoon(id);
    this.addTimeline(id, 'feedback', describeVerdict(result), {
      label: gate.kind,
      meta: { gateId, verdict: result.verdict },
    });
    this.emitEvent({ type: 'snapshot', session: state });
    this.broadcastSessionList();
    this.emit('gate:resolved', { sessionId: id, gate });
    return gate;
  }

  /**
   * A gate the user has already answered but Claude has not yet been told
   * about. This happens whenever the user answers faster than the turn ends.
   */
  undeliveredGate(id: string): Gate | undefined {
    return this.sessions.get(id)?.gates.find((g) => g.status === 'resolved' && g.result && !g.deliveredAt);
  }

  markGateDelivered(id: string, gateId: string): Gate | undefined {
    const gate = this.getGate(id, gateId);
    if (!gate || gate.deliveredAt) return gate;
    const now = Date.now();
    gate.deliveredAt = now;

    // The comments carried by this verdict reached Claude at the same moment,
    // so stamp them too — otherwise the UI keeps showing them as unsent and
    // the next round can never close them out.
    const state = this.sessions.get(id);
    if (state) {
      for (const delivered of gate.result?.threads ?? []) {
        const live = state.threads.find((t) => t.id === delivered.id);
        if (live && !live.deliveredAt) live.deliveredAt = now;
      }
      this.emitEvent({ type: 'state', sessionId: id, patch: { gates: state.gates, threads: state.threads } });
    }
    this.persistSoon(id);
    return gate;
  }

  setGateWaiting(id: string, gateId: string, waiting: boolean): void {
    const gate = this.getGate(id, gateId);
    if (!gate) return;
    gate.waiting = waiting;
    const state = this.sessions.get(id);
    if (state) {
      const status = waiting ? 'waiting' : state.status === 'waiting' ? 'active' : state.status;
      this.update(id, { status, gates: state.gates });
    }
  }

  /* ---------------------------------------------------------------- *
   * Async feedback queue
   * ---------------------------------------------------------------- */

  queueFeedback(id: string, item: Omit<FeedbackItem, 'id' | 'createdAt'>): FeedbackItem | undefined {
    const state = this.sessions.get(id);
    if (!state) return undefined;
    const full: FeedbackItem = { id: randomUUID(), createdAt: Date.now(), ...item };
    state.pendingFeedback.push(full);
    if (full.threads?.length) {
      const byId = new Map(state.threads.map((t) => [t.id, t]));
      for (const t of full.threads) byId.set(t.id, t);
      state.threads = [...byId.values()];
    }
    state.updatedAt = full.createdAt;
    this.persistSoon(id);
    this.addTimeline(id, 'feedback', full.text, { label: full.origin });
    this.emitEvent({ type: 'state', sessionId: id, patch: { pendingFeedback: state.pendingFeedback } });
    this.broadcastSessionList();
    this.emit('feedback:queued', { sessionId: id, item: full });
    return full;
  }

  /** Remove and return everything queued; called at a turn boundary. */
  drainFeedback(id: string): FeedbackItem[] {
    const state = this.sessions.get(id);
    if (!state || state.pendingFeedback.length === 0) return [];
    const drained = state.pendingFeedback;
    state.pendingFeedback = [];
    const now = Date.now();
    for (const item of drained) {
      for (const t of item.threads ?? []) {
        const live = state.threads.find((x) => x.id === t.id);
        if (live) live.deliveredAt = now;
      }
    }
    state.updatedAt = now;
    this.persistSoon(id);
    this.emitEvent({ type: 'state', sessionId: id, patch: { pendingFeedback: [], threads: state.threads } });
    this.broadcastSessionList();
    return drained;
  }

  /* ---------------------------------------------------------------- *
   * Diffs
   * ---------------------------------------------------------------- */

  setDiff(id: string, diff: DiffPayload): void {
    this.diffs.set(id, diff);
    // Persisted so a daemon restart mid-review does not leave the session
    // intact but the Review tab empty.
    try {
      const dir = paths.sessionDir(id);
      mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.diff.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(diff));
      renameSync(tmp, path.join(dir, 'diff.json'));
    } catch {
      /* best effort */
    }
    this.emitEvent({ type: 'diff', sessionId: id, diff });
  }

  getDiff(id: string): DiffPayload | undefined {
    const cached = this.diffs.get(id);
    if (cached) return cached;
    try {
      const file = path.join(paths.sessionDir(id), 'diff.json');
      if (!existsSync(file)) return undefined;
      const diff = JSON.parse(readFileSync(file, 'utf8')) as DiffPayload;
      this.diffs.set(id, diff);
      return diff;
    } catch {
      return undefined;
    }
  }

  /** Append a reply to a review thread and tell every client. */
  addThreadReply(
    id: string,
    threadId: string,
    reply: { author: 'user' | 'claude'; text: string },
  ): ReviewThread | undefined {
    let updated: ReviewThread | undefined;
    this.mutate(id, (s) => {
      const thread = s.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.replies = [
        ...(thread.replies ?? []),
        { id: randomUUID(), ts: Date.now(), author: reply.author, text: reply.text },
      ];
      updated = thread;
    });
    return updated;
  }

  setThreadResolved(id: string, threadId: string, resolved: boolean): ReviewThread | undefined {
    let updated: ReviewThread | undefined;
    this.mutate(id, (s) => {
      const thread = s.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.resolved = resolved;
      updated = thread;
    });
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Fan-out
   * ---------------------------------------------------------------- */

  emitEvent(event: ServerEvent): void {
    this.emit('event', event);
  }

  broadcastSessionList(): void {
    this.emitEvent({ type: 'sessions', sessions: this.summaries() });
  }
}

function describeVerdict(result: GateResult): string {
  const bits: string[] = [];
  switch (result.verdict) {
    case 'approved':
      bits.push('Approved');
      break;
    case 'changes_requested':
      bits.push('Changes requested');
      break;
    case 'rejected':
      bits.push('Rejected');
      break;
    case 'answered':
      bits.push('Answered');
      break;
  }
  if (result.threads?.length) bits.push(`${result.threads.length} line comment(s)`);
  if (result.comment) bits.push(result.comment);
  return bits.join(' — ');
}

export { sanitizeId };
