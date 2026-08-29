import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
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

/**
 * Retention bounds.
 *
 * The daemon is started once by a hook and can then run for weeks, and it
 * loads every session it has ever recorded on boot. Without these, resident
 * memory is a function of how long the user has had the plugin installed
 * rather than of what they are doing right now.
 */
/** Sessions older than this are dropped from memory and from disk on boot. */
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard cap on sessions held in memory, newest first. */
const MAX_SESSIONS = 60;
/** Resolved gates retained per session; each one carries its full verdict. */
const MAX_GATES = 40;
/** Parsed diffs cached in memory. Each can be several megabytes. */
/** Exported so tests can assert eviction at the real boundary rather than
 *  duplicating the number and drifting from it. */
export const MAX_CACHED_DIFFS = 12;

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

    const loaded: SessionState[] = [];
    const expired: string[] = [];
    const cutoff = Date.now() - SESSION_TTL_MS;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(dir, entry.name);
      const file = path.join(sessionDir, 'state.json');
      if (!existsSync(file)) {
        // A directory with no state was created by `ensure` for a session
        // that never produced one. It is dead weight either way.
        if (mtimeOf(sessionDir) < cutoff) expired.push(sessionDir);
        continue;
      }
      try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
        if (!state.sessionId) continue;
        if ((state.updatedAt ?? 0) < cutoff) {
          expired.push(sessionDir);
          continue;
        }
        migrate(state);
        loaded.push(state);
      } catch {
        /* skip unreadable session */
      }
    }

    // Newest first, then cap. Anything past the cap stays on disk — it is not
    // stale, just cold, and a later `harness status` should still find it.
    loaded.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const state of loaded.slice(0, MAX_SESSIONS)) {
      this.sessions.set(state.sessionId, state);
    }
    for (const sessionDir of expired) discardDir(sessionDir);
  }

  /** Read one session from disk, or undefined if there is nothing to read. */
  private readSession(id: string): SessionState | undefined {
    try {
      const file = paths.sessionState(id);
      if (!existsSync(file)) return undefined;
      const state = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
      if (!state.sessionId) return undefined;
      migrate(state);
      return state;
    } catch {
      return undefined;
    }
  }

  /**
   * Forget a session: memory, cached diff, and any pending write.
   *
   * On-disk state is left alone — this is eviction, not deletion — so the
   * session is still there if the daemon restarts and the user goes looking.
   */
  drop(id: string): boolean {
    const timer = this.persistTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
      // The pending write was carrying real changes; do not lose them.
      this.persistNow(id);
    }
    this.diffs.delete(id);
    const removed = this.sessions.delete(id);
    if (removed) this.broadcastSessionList();
    return removed;
  }

  /**
   * Delete a session for good: memory, cached diff, pending write, and the
   * whole on-disk directory.
   *
   * Unlike `drop`, this is not eviction. `ensure` reads state back off disk
   * when a swept session reappears, so anything short of removing the
   * directory would resurrect the session the next time a hook mentioned it —
   * which is exactly what a user who clicked "delete" did not ask for.
   */
  purge(id: string): boolean {
    const timer = this.persistTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
    }
    this.diffs.delete(id);
    const removed = this.sessions.delete(id);
    discardDir(paths.sessionDir(id));
    if (removed) this.broadcastSessionList();
    return removed;
  }

  /**
   * Evict sessions that ended a while ago, and trim gate history on the rest.
   *
   * Called on a timer by the daemon. A long-lived daemon accumulates finished
   * sessions the user will never look at again; each one holds its timeline,
   * every gate verdict, and its cached diff.
   */
  sweep(opts: { endedTtlMs: number; now?: number } = { endedTtlMs: 60 * 60 * 1000 }): number {
    const now = opts.now ?? Date.now();
    let dropped = 0;
    for (const state of [...this.sessions.values()]) {
      trimGates(state);
      const finished = state.status === 'ended';
      if (finished && now - (state.endedAt ?? state.updatedAt) > opts.endedTtlMs) {
        this.drop(state.sessionId);
        dropped++;
      }
    }
    // Oldest-first eviction once the cap is exceeded, regardless of status.
    const overflow = this.all().slice(MAX_SESSIONS);
    for (const state of overflow) {
      this.drop(state.sessionId);
      dropped++;
    }
    return dropped;
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
      // A swept session still has its state on disk. Creating a blank one
      // here would persist straight over the top of it, so a `--resume` an
      // hour later would find its whole history gone.
      state = this.readSession(id) ?? newSession(id, cwd || process.cwd());
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
      repoRoot: s.repoRoot,
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
    trimGates(state);
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
    this.cacheDiff(id, diff);
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
    if (cached) {
      // Re-insert on a hit. Without this the eviction order is insertion
      // order, not recency, so the diff being actively reviewed is the one
      // most likely to be thrown out while colder entries survive.
      this.cacheDiff(id, cached);
      return cached;
    }
    try {
      const file = path.join(paths.sessionDir(id), 'diff.json');
      if (!existsSync(file)) return undefined;
      const diff = JSON.parse(readFileSync(file, 'utf8')) as DiffPayload;
      this.cacheDiff(id, diff);
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

  /**
   * Keep the diff cache bounded, evicting least-recently-used.
   *
   * Every entry is a fully parsed diff — up to `maxDiffFileBytes` per file —
   * and the previous behaviour kept one per session forever. Re-inserting
   * moves a key to the end of the Map's iteration order, which is the LRU
   * position we evict from the front of.
   */
  private cacheDiff(id: string, diff: DiffPayload): void {
    this.diffs.delete(id);
    this.diffs.set(id, diff);
    while (this.diffs.size > MAX_CACHED_DIFFS) {
      const oldest = this.diffs.keys().next();
      if (oldest.done) break;
      this.diffs.delete(oldest.value);
    }
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

/**
 * Bring a session read from disk up to date.
 *
 * Shared by the startup scan and the single-session rehydrate, so the two can
 * never drift into applying different fixups to the same file.
 */
function migrate(state: SessionState): void {
  // Sessions written by an older build predate some fields.
  state.reviewRound ??= 0;
  state.threads ??= [];
  state.roundHistory ??= [];
  state.tasks ??= [];
  // A session cannot still be mid-turn across a daemon restart.
  if (state.status === 'active') state.status = 'idle';
  // Any gate that was parked has lost its waiter.
  for (const gate of state.gates) gate.waiting = false;
  trimGates(state);
}

/**
 * Cap a session's gate history.
 *
 * Every gate retains its full `GateResult` — the comment, the edited plan, and
 * each review thread with its source excerpt. A session that goes through many
 * review rounds would otherwise carry all of them in memory and rewrite the
 * lot to disk on every persist. Open and undelivered gates are never dropped:
 * something is still waiting on them.
 */
function trimGates(state: SessionState): void {
  if (state.gates.length <= MAX_GATES) return;
  const keep = new Set<Gate>();
  for (const gate of state.gates) {
    if (gate.status === 'open' || (gate.result && !gate.deliveredAt)) keep.add(gate);
  }
  const droppable = state.gates.filter((g) => !keep.has(g));
  const surplus = state.gates.length - MAX_GATES;
  const drop = new Set(droppable.slice(0, Math.max(0, surplus)));
  if (drop.size === 0) return;
  state.gates = state.gates.filter((g) => !drop.has(g));
}

function mtimeOf(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}

function discardDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a session directory we cannot remove is not worth failing boot over */
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
