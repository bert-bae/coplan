import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { paths, ensureHome, sanitizeId } from '../shared/paths.ts';
import { applyOps, countTasks, currentTask, emptyPlan, markReadByClaude, normalizePlan, publishPlan, unreadItems } from '../shared/plan.ts';
import type { Author, Change, Plan, PlanInput, PlanOp, ServerEvent, SessionState, SessionSummary } from '../shared/types.ts';

const PERSIST_DEBOUNCE_MS = 400;

/**
 * Retention bounds. The daemon is started once by a hook and can then run for
 * weeks, and it loads every session it has recorded on boot.
 */
/** Sessions untouched for longer than this are dropped from memory and disk on boot. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on sessions held in memory, newest first. */
const MAX_SESSIONS = 60;

export function newSession(sessionId: string, cwd: string): SessionState {
  const now = Date.now();
  return {
    sessionId,
    cwd,
    repoRoot: null,
    branch: null,
    title: path.basename(cwd) || sessionId.slice(0, 8),
    status: 'active',
    waiting: null,
    surface: 'unknown',
    link: null,
    createdAt: now,
    updatedAt: now,
    plan: null,
  };
}

/**
 * In-memory registry of every session the harness has seen, with
 * write-behind persistence and an SSE fan-out.
 *
 * Every change broadcasts the whole session. A plan is a few kilobytes, and
 * one shape of update is far easier to keep correct than a family of patches.
 */
export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.setMaxListeners(0);
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
        if (mtimeOf(sessionDir) < cutoff) expired.push(sessionDir);
        continue;
      }
      const state = readState(file);
      if (!state) continue;
      if ((state.updatedAt ?? 0) < cutoff) {
        expired.push(sessionDir);
        continue;
      }
      loaded.push(state);
    }

    // Anything past the cap stays on disk — cold, not stale.
    loaded.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const state of loaded.slice(0, MAX_SESSIONS)) this.sessions.set(state.sessionId, state);
    for (const sessionDir of expired) discardDir(sessionDir);
  }

  /** Forget a session in memory; its state stays on disk. */
  drop(id: string): boolean {
    const timer = this.persistTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
      this.persistNow(id);
    }
    const removed = this.sessions.delete(id);
    if (removed) this.broadcastSessionList();
    return removed;
  }

  /**
   * Delete a session for good, on disk too. Anything short of removing the
   * directory would let `ensure` resurrect it the next time a hook fired.
   */
  purge(id: string): boolean {
    const timer = this.persistTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
    }
    const removed = this.sessions.delete(id);
    discardDir(paths.sessionDir(id));
    if (removed) this.broadcastSessionList();
    return removed;
  }

  /** Evict sessions that ended a while ago, then enforce the cap. */
  sweep(opts: { endedTtlMs: number; now?: number } = { endedTtlMs: 60 * 60 * 1000 }): number {
    const now = opts.now ?? Date.now();
    let dropped = 0;
    for (const state of [...this.sessions.values()]) {
      if (state.status === 'ended' && now - (state.endedAt ?? state.updatedAt) > opts.endedTtlMs) {
        this.drop(state.sessionId);
        dropped++;
      }
    }
    for (const state of this.all().slice(MAX_SESSIONS)) {
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

  /** Get or create. A session that was swept from memory is read back from
   *  disk rather than overwritten with a blank one. */
  ensure(id: string, cwd?: string): SessionState {
    let state = this.sessions.get(id);
    if (!state) {
      state = readState(paths.sessionState(id)) ?? newSession(id, cwd || process.cwd());
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

  /** The rail's rows, newest session first. Ordered on creation so rows
   *  never move out from under the cursor. */
  summaries(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => summarize(s));
  }

  /** Most recently updated session rooted at `cwd`. */
  findByCwd(cwd: string): SessionState | undefined {
    const normalized = path.resolve(cwd);
    const matches = (value: string | null | undefined) => !!value && path.resolve(value) === normalized;
    return this.all().find((s) => matches(s.cwd) || matches(s.repoRoot));
  }

  findByPid(pid: number): SessionState | undefined {
    return this.all().find((s) => s.claudePid === pid);
  }

  /* ---------------------------------------------------------------- *
   * Mutation
   * ---------------------------------------------------------------- */

  update(id: string, patch: Partial<SessionState>): SessionState | undefined {
    return this.mutate(id, (s) => Object.assign(s, patch));
  }

  /** Mutate in place, persist, and broadcast the whole session. */
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

  /** Claude publishes the plan wholesale. Throws `PlanError` when refused. */
  publishPlan(id: string, input: PlanInput): { plan: Plan; changes: Change[] } {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    const result = publishPlan(session.plan, input);
    this.mutate(id, (s) => {
      s.plan = result.plan;
    });
    return result;
  }

  /** Apply edits from either side. Throws `PlanError` when any op fails, in
   *  which case nothing is changed. */
  applyOps(id: string, ops: PlanOp[], author: Author): { plan: Plan; changes: Change[] } {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    // The user can start a plan from the browser before Claude has published.
    const base = session.plan ?? emptyPlan(session.title);
    const result = applyOps(base, ops, author);
    this.mutate(id, (s) => {
      s.plan = result.plan;
    });
    return result;
  }

  /** Move Claude's read position to the end of the change log. */
  markRead(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.plan) return;
    if (session.plan.claudeReadSeq === session.plan.seq && session.plan.claudeReadAt && session.plan.claudeBaseline) return;
    this.mutate(id, (s) => {
      if (s.plan) markReadByClaude(s.plan);
    });
  }

  /* ---------------------------------------------------------------- *
   * Fan-out
   * ---------------------------------------------------------------- */

  emitEvent(event: ServerEvent): void {
    this.emit('event', event);
  }

  /**
   * The rail's list, coalesced: a canvas drag or a batch of hook events can
   * change a session many times in one tick, and every open page only needs
   * the last of them.
   */
  broadcastSessionList(): void {
    if (this.listQueued) return;
    this.listQueued = true;
    setImmediate(() => {
      this.listQueued = false;
      this.emitEvent({ type: 'sessions', sessions: this.summaries() });
    });
  }

  private listQueued = false;
}

export function summarize(s: SessionState): SessionSummary {
  const plan = s.plan;
  return {
    sessionId: s.sessionId,
    title: s.title,
    planTitle: plan?.title ?? null,
    cwd: s.cwd,
    repoName: s.repoRoot ? path.basename(s.repoRoot) : null,
    repoRoot: s.repoRoot,
    branch: s.branch,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    tasks: countTasks(plan),
    current: currentTask(plan)?.title ?? null,
    waiting: s.waiting,
    surface: s.surface,
    link: s.link,
    openThreads: plan?.threads.filter((t) => !t.resolved).length ?? 0,
    unreadByClaude: unreadItems(plan),
  };
}

/**
 * Read one session's state, or undefined if there is none.
 *
 * A file that exists but cannot be read is moved aside rather than ignored:
 * ignoring it would let the next save write a blank session over the top of
 * a plan that might still be recoverable by hand.
 */
function readState(file: string): SessionState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
    if (!state || typeof state !== 'object' || typeof state.sessionId !== 'string') throw new Error('not a session');
    migrate(state);
    return state;
  } catch {
    quarantine(file);
    return undefined;
  }
}

function quarantine(file: string): void {
  try {
    renameSync(file, path.join(path.dirname(file), `state.corrupt-${Date.now()}.json`));
  } catch {
    /* if it cannot be moved it cannot be overwritten either */
  }
}

/**
 * Bring a session written by an older build up to date.
 *
 * Builds before the planning rewrite stored a flat step list and a pile of
 * review-loop state. The steps become top-level tasks and the prose becomes a
 * section; the rest has no meaning any more and is dropped.
 */
function migrate(state: SessionState): void {
  const raw = state as unknown as Record<string, unknown>;
  state.updatedAt = typeof state.updatedAt === 'number' ? state.updatedAt : Date.now();
  state.createdAt ??= state.updatedAt;
  state.title = typeof state.title === 'string' && state.title ? state.title : state.sessionId.slice(0, 8);
  state.cwd = typeof state.cwd === 'string' ? state.cwd : '';
  if (state.status !== 'ended') state.status = 'idle';

  const oldPlan = raw['plan'] as Record<string, unknown> | null | undefined;
  if (oldPlan && !Array.isArray(oldPlan['tasks'])) {
    const plan = emptyPlan(String(oldPlan['title'] ?? state.title));
    plan.summary = typeof oldPlan['summary'] === 'string' ? oldPlan['summary'] : '';
    if (typeof oldPlan['markdown'] === 'string' && oldPlan['markdown'].trim()) {
      plan.sections.push({ id: 's1', title: 'Notes', body: oldPlan['markdown'], rev: 1, updatedAt: Date.now(), updatedBy: 'claude' });
    }
    const steps = Array.isArray(oldPlan['steps']) ? (oldPlan['steps'] as Record<string, unknown>[]) : [];
    steps.forEach((step, i) => {
      const now = Date.now();
      plan.tasks.push({
        id: `t${i + 1}`,
        parentId: null,
        order: i,
        title: String(step['title'] ?? `Step ${i + 1}`),
        ...(typeof step['detail'] === 'string' ? { detail: step['detail'] } : {}),
        status: step['status'] === 'done' ? 'done' : 'todo',
        createdAt: now,
        updatedAt: now,
        createdBy: 'claude',
      });
    });
    state.plan = plan;
  }
  state.plan = state.plan && typeof state.plan === 'object' ? normalizePlan(state.plan as Plan & Record<string, unknown>, state.title) : null;
  // Plans saved before questions moved into Claude's own chat.
  if (state.plan) {
    const plan = state.plan as unknown as Record<string, unknown>;
    delete plan['questions'];
    state.plan.threads = state.plan.threads.filter((t) => (t.target.kind as string) !== 'question');
    state.plan.changes = state.plan.changes.filter((c) => (c.target.kind as string) !== 'question');
  }
  // A waiting state cannot survive a restart: whatever was asked has moved on.
  state.waiting = null;
  state.surface ??= 'unknown';
  state.link ??= null;

  for (const key of [
    'worktree', 'transcriptPath', 'stage', 'stageNote', 'baseRef', 'startCommit', 'reviewRound',
    'roundHistory', 'tasks', 'usage', 'todos', 'files', 'commands', 'timeline', 'gates',
    'activeGateId', 'threads', 'checks', 'ship', 'pendingFeedback', 'stats',
  ]) {
    delete raw[key];
  }
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
    /* not worth failing over */
  }
}

export { sanitizeId };
