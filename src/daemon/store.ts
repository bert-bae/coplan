import { EventEmitter } from 'node:events';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { paths, ensureHome, legacyName, sanitizeId } from '../shared/paths.ts';
import {
  PlanError,
  applyOps,
  awaitingUserReview,
  holdsForReview,
  confirmDesign,
  countTasks,
  currentTask,
  emptyPlan,
  markDelivered,
  markDesignDelivered,
  markReadByClaude,
  markRevisionDelivered,
  normalizePlan,
  pendingRevision,
  queueRevision,
  withdrawRevision,
  planPhase,
  planStatus,
  publishPlan,
  publishTasks,
  reopenDesign,
  reopenPlan,
  submitPlan,
  unreadItems,
} from '../shared/plan.ts';
import { BUILD_MARKER, DESIGN_MARKER, PROMPT_MOVED, REVISION_MARKER, buildPrompt, designPrompt, promptHash, revisionPrompt, type PromptOptions } from './render.ts';

const REVISION_MOVED =
  'The request changed since you read it (a comment was added, answered or resolved). It now shows what would be sent — read it, then send it again.';
import { blockingGaps } from '../shared/check.ts';
import { DEFAULT_BUILD_SETTINGS, modeFor } from '../shared/build.ts';
import { DEFAULT_AGENT, isAgentKind, type AgentKind } from '../shared/agents.ts';
import type { Author, BuildTarget, Change, Plan, PlanInput, PlanOp, ReviewMode, ServerEvent, SessionState, SessionSummary, TaskListInput } from '../shared/types.ts';

const PERSIST_DEBOUNCE_MS = 400;

/**
 * Retention bounds. The daemon is started once by a hook and can then run for
 * weeks, and it loads every session it has recorded on boot.
 */
/** Sessions untouched for longer than this are dropped from memory and disk on boot. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Not past keeping: saved (or, for a folder with no state, touched)
 *  within SESSION_TTL_MS. A start deletes what is past it; ensure dates
 *  anew one it reads back past it. */
const fresh = (time: number, now: number) => time >= now - SESSION_TTL_MS;
/** Sessions kept in memory per pool (see `kept`). */
const MAX_SESSIONS = 60;

/**
 * Which sessions stay in memory, and so in the browser's list and for
 * `coplan open` and finding a session by its pid or folder, when there are
 * more than fit: the newest of those the user planned in (a plan, or Coplan
 * used), and the newest of the rest, each up to the cap. Two pools, so the
 * many sessions that never touch Coplan cannot push out a plan, nor a pile
 * of old plans a session running now. Past them a session stays on disk.
 */
function kept(states: SessionState[]): SessionState[] {
  const newest = [...states].sort((a, b) => b.updatedAt - a.updatedAt);
  // A newer build's session is blank here, but a used one on disk.
  const used = (s: SessionState) => Boolean(s.plan || s.engagedAt || s.savedByNewer);
  const planned = newest.filter(used);
  const plain = newest.filter((s) => !used(s));
  return [...planned.slice(0, MAX_SESSIONS), ...plain.slice(0, MAX_SESSIONS)];
}

export function newSession(sessionId: string, cwd: string, agent: AgentKind = DEFAULT_AGENT): SessionState {
  const now = Date.now();
  return {
    sessionId,
    agent,
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
    // Known only from a tool call until one of its hooks arrives.
    hookedAt: null,
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
/**
 * The format of a session's `state.json`. Raise it when a change means an
 * older build would misread the file; a build never writes over a file in
 * a format newer than its own.
 */
export const STATE_SCHEMA = 1;

/** readState's answer for a file in a newer format. */
const NEWER = Symbol('newer');

export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  /** The last write failure said for each session, so it is said once. */
  private persistFailed = new Map<string, string>();
  /** Save failures raised before anyone listened, for the first listener. */
  private unheard: ServerEvent[] = [];
  /** The project's review mode for a session: what a plan with none of its
   *  own (not a submitted Managed build) is judged by, as the daemon's gates
   *  judge it. Set by the daemon; every edit falls back to it. */
  reviewFor?: (session: SessionState) => ReviewMode;

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

    const found: { state: SessionState; old: boolean }[] = [];
    // The folders that hold a session's state: a readable one not past
    // keeping, or a newer Coplan's.
    const taken = new Set<string>();
    const expired: string[] = [];
    const now = Date.now();

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(dir, entry.name);
      const file = path.join(sessionDir, 'state.json');
      if (!existsSync(file)) {
        if (!fresh(mtimeOf(sessionDir), now)) expired.push(sessionDir);
        continue;
      }
      const state = readState(file);
      // One written by a newer Coplan than this daemon is left exactly as it
      // is until that build runs: not loaded, and never saved over
      // (`savedByNewer`, set by ensure and checked by persistNow).
      if (state === NEWER) taken.add(entry.name);
      if (!state || state === NEWER) continue;
      if (!fresh(state.updatedAt ?? 0, now)) {
        expired.push(sessionDir);
        continue;
      }
      taken.add(entry.name);
      found.push({ state, old: entry.name !== sanitizeId(state.sessionId) });
    }

    // One copy a session. A folder named by an earlier build, which made an
    // id safe without its hash (see sanitizeId), is read only while the
    // session's own folder holds no readable state (nor a newer build's),
    // and saved there once loaded. Its time is not weighed against the own
    // copy's: a tie, a fresh stamp from that build's hook, a clock running
    // ahead would each put it over work done since. Left as it is, for
    // housekeeping, and for that earlier build.
    const chosen = new Map<string, { state: SessionState; old: boolean }>();
    for (const copy of found) {
      const own = sanitizeId(copy.state.sessionId);
      if (copy.old && taken.has(own)) continue;
      chosen.set(copy.state.sessionId, copy);
    }
    // Anything past the cap stays on disk — cold, not stale.
    const loaded = kept([...chosen.values()].map((c) => c.state));
    for (const state of loaded) this.sessions.set(state.sessionId, state);
    // Expired first: a session's own folder past keeping is where a copy
    // from its old folder goes.
    for (const sessionDir of expired) discardDir(sessionDir);
    for (const state of loaded) if (chosen.get(state.sessionId)?.old || datedByFile.has(state)) this.persistNow(state.sessionId);
    // One past the cap, cold in its own folder, keeps the date its file gave
    // it too: written back as it is, with no one to tell if that fails (it
    // is tried again when it is read).
    for (const { state, old } of chosen.values()) {
      if (this.sessions.get(state.sessionId) === state || old || !datedByFile.has(state)) continue;
      try {
        writeState(paths.sessionDir(state.sessionId), state);
      } catch {
        /* see above */
      }
    }
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
    this.persistFailed.delete(id);
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
    this.persistFailed.delete(id);
    // A session's folder, and only one: never sessions/ or what holds it.
    // One an earlier build kept it in goes too, or the next start reads it.
    const dir = paths.sessionDir(id);
    if (path.dirname(dir) === paths.sessionsDir()) discardDir(dir);
    const old = legacyFile(id);
    if (old && ownerOf(old) === id) discardDir(path.dirname(old));
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
    const keep = new Set(kept([...this.sessions.values()]).map((s) => s.sessionId));
    for (const id of [...this.sessions.keys()]) {
      if (keep.has(id)) continue;
      this.drop(id);
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
    if (!state || state.savedByNewer) return;
    try {
      writeState(paths.sessionDir(id), state);
      this.persistFailed.delete(id);
    } catch (err) {
      // The live session goes on — but nobody may be told their edits are
      // saved when they are not. Said once per kind of failure, not per edit.
      this.saveFailed(id, err);
    }
  }

  private saveFailed(id: string, err: unknown): void {
    const message = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err);
    if (this.persistFailed.get(id) === message) return;
    this.persistFailed.set(id, message);
    this.emitEvent({ type: 'persist-error', sessionId: id, message });
  }

  /** Why the session's state cannot be saved now (said once when it
   *  started failing), for a page that opens on it later. */
  saveFailure(id: string): string | undefined {
    return this.persistFailed.get(id);
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
  ensure(id: string, cwd?: string, agent?: AgentKind): SessionState {
    let state = this.sessions.get(id);
    if (!state) {
      const { saved, old } = this.readSaved(id);
      // No folder (a Codex tool call, whose hooks are not trusted yet) is
      // left unknown: the daemon's own is some other session's repository,
      // and its checks, base branch and git would be taken for this one's.
      state = saved && saved !== NEWER ? saved : newSession(id, cwd ?? '', agent);
      // A newer build's session is served blank from memory, marked so the
      // page says why, and never saved (persistNow).
      if (saved === NEWER) state.savedByNewer = true;
      // Read back past keeping: a hook asks for it, so it is live, and dated
      // now, or the next start would delete it.
      const revived = saved && saved !== NEWER && !fresh(saved.updatedAt ?? 0, Date.now());
      if (revived) state.updatedAt = Date.now();
      this.sessions.set(id, state);
      mkdirSync(paths.sessionDir(id), { recursive: true });
      // Read from the folder an earlier build kept it in: saved to its own.
      if (old || revived || datedByFile.has(state)) this.persistNow(id);
      this.emitEvent({ type: 'snapshot', session: state });
      this.broadcastSessionList();
    } else if (cwd && state.cwd !== cwd && !state.repoRoot) {
      // A session first seen with no folder learns it here, and takes its
      // name rather than its id's, as one seen first by its hooks does.
      if (!state.cwd && !state.titleLocked && state.title === id.slice(0, 8)) state.title = path.basename(cwd) || state.title;
      state.cwd = cwd;
    }
    return state;
  }

  /**
   * A session's saved state: from its own folder or, while that holds no
   * state file, from the folder an earlier build kept it in (see
   * loadFromDisk), if the state there is this session's. Whatever its age:
   * a hook asks for it, so it is live (and ensure dates it now). A state in its own folder that is another session's (an earlier
   * build's, whose id this one is spelled like that session's folder name)
   * is no state of this one's: it is first copied to that session's own
   * folder, unless that session is here to save itself, so this one's saves
   * take nothing from it.
   */
  private readSaved(id: string): { saved: SessionState | typeof NEWER | undefined; old: boolean } {
    const file = paths.sessionState(id);
    const legacy = () => {
      const old = legacyFile(id);
      const state = old ? readState(old) : undefined;
      return state && state !== NEWER && state.sessionId === id ? state : undefined;
    };
    if (existsSync(file)) {
      const own = readState(file);
      if (own === NEWER) return { saved: own, old: false };
      // Unreadable, and moved aside: as though its folder held nothing.
      if (!own) {
        const saved = legacy();
        return { saved, old: saved !== undefined };
      }
      if (own.sessionId === id) return { saved: own, old: false };
      if (!this.sessions.has(own.sessionId) && !existsSync(paths.sessionState(own.sessionId))) {
        try {
          writeState(paths.sessionDir(own.sessionId), own);
          this.persistFailed.delete(own.sessionId);
        } catch (err) {
          // Said as any failed save is, once per kind (and logged): this
          // one's saves wait on nothing.
          this.saveFailed(own.sessionId, err);
        }
      }
      return { saved: undefined, old: false };
    }
    const saved = legacy();
    return { saved, old: saved !== undefined };
  }

  all(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The rail's rows, newest session first. Ordered on creation so rows
   *  never move out from under the cursor. */
  summaries(): SessionSummary[] {
    // The project's review mode, read only where it can count — a Managed
    // build (the only kind that holds work for a review) submitted on the
    // repository's defaults — and once a repository.
    const byRoot = new Map<string, ReviewMode | undefined>();
    const reviewOf = (s: SessionState): ReviewMode | undefined => {
      if (!holdsForReview(s.plan) || s.plan.submission.settings || !this.reviewFor) return undefined;
      const root = s.repoRoot ?? s.cwd;
      if (!byRoot.has(root)) byRoot.set(root, this.reviewFor(s));
      return byRoot.get(root);
    };
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map((s) => summarize(s, reviewOf(s)));
  }

  /** Most recently updated session rooted at `cwd` — of `agent`, when one is
   *  named, so a Cursor window never picks up a Claude session in the same
   *  folder. */
  findByCwd(cwd: string, agent?: AgentKind): SessionState | undefined {
    const normalized = path.resolve(cwd);
    const matches = (value: string | null | undefined) => !!value && path.resolve(value) === normalized;
    return this.all().find((s) => (!agent || s.agent === agent) && (matches(s.cwd) || matches(s.repoRoot)));
  }

  findByPid(pid: number, agent?: AgentKind): SessionState | undefined {
    return this.all().find((s) => s.claudePid === pid && (!agent || s.agent === agent));
  }

  /* ---------------------------------------------------------------- *
   * Mutation
   * ---------------------------------------------------------------- */

  update(id: string, patch: Partial<SessionState>): SessionState | undefined {
    return this.mutate(id, (s) => Object.assign(s, patch));
  }

  /** The session has started using Coplan, so the rail lists it. Stamped
   *  once: a later /coplan does not move when it began. */
  engage(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.engagedAt) this.update(id, { engagedAt: Date.now() });
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

  /** Claude publishes the task list for the design. Throws `PlanError`. */
  publishTasks(id: string, input: TaskListInput): { plan: Plan; changes: Change[] } {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    const result = publishTasks(session.plan, input);
    this.mutate(id, (s) => {
      s.plan = result.plan;
    });
    return result;
  }

  /** Apply edits from either side. Throws `PlanError` when any op fails, in
   *  which case nothing is changed. */
  applyOps(id: string, ops: PlanOp[], author: Author, opts: { tracking?: boolean; review?: ReviewMode } = {}): { plan: Plan; changes: Change[] } {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    // The user can start a plan from the browser before Claude has published.
    const base = session.plan ?? emptyPlan(session.title);
    const review = opts.review ?? this.reviewFor?.(session);
    const result = applyOps(base, ops, author, Date.now(), { ...opts, ...(review ? { review } : {}) });
    this.mutate(id, (s) => {
      s.plan = result.plan;
    });
    return result;
  }

  /**
   * The user submits the plan to be built. The prompt is built here, from
   * the plan as the daemon holds it, and only if that is still the version
   * the user previewed — what they read is what Claude gets.
   */
  submit(id: string, input: PromptOptions & { target: BuildTarget; expect?: number; hash?: string; userSaid?: string }): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    const plan = session.plan;
    if (!plan) throw new PlanError('There is no plan to submit yet.');
    if (typeof input.expect === 'number' && input.expect !== plan.version) {
      throw new PlanError('The plan changed while you were reviewing it. The preview now shows the latest version — check it, then submit again.');
    }
    refuseBlockingGaps(plan, input, 'submitted');
    const { prompt, trimmed } = buildPrompt(plan, { ...input, agent: session.agent });
    if (input.hash !== undefined && input.hash !== promptHash(prompt)) throw new PlanError(PROMPT_MOVED('submit'));
    const mode = modeFor(input.target, input.mode, input.project?.mode ?? 'tracked');
    const next = submitPlan(plan, {
      target: input.target,
      mode,
      prompt,
      trimmed,
      ...(input.note ? { note: input.note } : {}),
      // A Managed build's settings: what the other modes leave to the agent.
      ...(input.settings && mode === 'managed' ? { settings: input.settings } : {}),
      ...(input.project?.branches.base ? { base: input.project.branches.base } : {}),
      ...(input.userSaid ? { userSaid: input.userSaid } : {}),
    });
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /**
   * The user confirms the design. Like submitting, the prompt is built here
   * from the plan as the daemon holds it, and only if that is the version
   * the user previewed.
   */
  confirmDesign(id: string, input: PromptOptions & { expect?: number; hash?: string; userSaid?: string }): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    const plan = session.plan;
    if (!plan) throw new PlanError('There is no plan to confirm yet.');
    if (typeof input.expect === 'number' && input.expect !== plan.version) {
      throw new PlanError('The plan changed while you were reviewing it. The preview now shows the latest version — check it, then confirm again.');
    }
    refuseBlockingGaps(plan, input, 'confirmed');
    const { prompt, trimmed } = designPrompt(plan, { ...input, agent: session.agent });
    if (input.hash !== undefined && input.hash !== promptHash(prompt)) throw new PlanError(PROMPT_MOVED('confirm'));
    const next = confirmDesign(plan, { prompt, trimmed, ...(input.note ? { note: input.note } : {}), ...(input.userSaid ? { userSaid: input.userSaid } : {}) });
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /** Unlock a confirmed design. */
  reopenDesign(id: string): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    if (!session.plan) throw new PlanError('There is no plan.');
    const next = reopenDesign(session.plan);
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /** Unlock a submitted plan. */
  reopen(id: string): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    if (!session.plan) throw new PlanError('There is no plan.');
    const next = reopenPlan(session.plan);
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /**
   * A prompt is on its way to Claude, if one is waiting — the build prompt,
   * or else the ask for a task list — returned with the marker it begins
   * with, and recorded as sent. Only ever once per sign-off.
   */
  /** The prompt waiting to reach the agent, if any, without sending it. */
  pending(id: string): { prompt: string; marker: string } | null {
    const plan = this.sessions.get(id)?.plan;
    if (!plan) return null;
    if (plan.submission) {
      return plan.submission.target === 'session' && !plan.submission.deliveredAt ? { prompt: plan.submission.prompt, marker: BUILD_MARKER } : null;
    }
    return plan.design && !plan.design.deliveredAt ? { prompt: plan.design.prompt, marker: DESIGN_MARKER } : null;
  }

  /**
   * Take back a delivery that never reached the agent — the hook's answer
   * was not received — so the next hook or harness_plan_read hands the
   * prompt over again. Only while nothing else has changed the plan since.
   */
  undeliver(id: string, prior: Plan, deliveredVersion: number): boolean {
    const session = this.sessions.get(id);
    if (!session?.plan || session.plan.version !== deliveredVersion) return false;
    this.mutate(id, (s) => {
      s.plan = { ...prior, version: deliveredVersion + 1, updatedAt: Date.now() };
    });
    this.persistNow(id);
    return true;
  }

  deliver(id: string): { prompt: string; marker: string } | null {
    const plan = this.sessions.get(id)?.plan;
    if (!plan) return null;
    const submission = plan.submission;
    let next: Plan;
    let out: { prompt: string; marker: string };
    if (submission) {
      if (submission.target !== 'session' || submission.deliveredAt) return null;
      next = markDelivered(plan);
      out = { prompt: submission.prompt, marker: BUILD_MARKER };
    } else if (plan.design && !plan.design.deliveredAt) {
      next = markDesignDelivered(plan);
      out = { prompt: plan.design.prompt, marker: DESIGN_MARKER };
    } else {
      return null;
    }
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return out;
  }

  /**
   * The user asks for the plan to be revised per their open comments (#67).
   * Like a sign-off, the request is built here from the plan as the daemon
   * holds it, and only if that is what the user previewed; it waits for
   * their next message in chat. Coplan starts no turn.
   */
  queueRevision(id: string, input: { note?: string; expect?: number; hash?: string }): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    const plan = session.plan;
    if (!plan) throw new PlanError('There is no plan to revise yet.');
    if (typeof input.expect === 'number' && input.expect !== plan.version) {
      throw new PlanError('The plan changed while you were reading the request. It now shows the latest — check it, then send it again.');
    }
    const built = revisionPrompt(plan, input.note ? { note: input.note } : {});
    if (input.hash !== undefined && input.hash !== promptHash(built.prompt)) throw new PlanError(REVISION_MOVED);
    const next = queueRevision(plan, {
      prompt: built.prompt,
      threadIds: built.threadIds,
      ...(input.note ? { note: input.note } : {}),
      ...(built.trimmed ? { trimmed: true } : {}),
    });
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /** Take back a revision request the agent has not been sent. */
  withdrawRevision(id: string): Plan {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown session');
    if (!session.plan) throw new PlanError('There is no plan.');
    const next = withdrawRevision(session.plan);
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return next;
  }

  /** The revision request waiting to reach the agent, without sending it. */
  pendingRevision(id: string): { prompt: string; marker: string } | null {
    const req = pendingRevision(this.sessions.get(id)?.plan ?? null);
    return req ? { prompt: req.prompt, marker: REVISION_MARKER } : null;
  }

  /** Hand the waiting revision request over, recorded as sent. Once. */
  deliverRevision(id: string): { prompt: string; marker: string } | null {
    const plan = this.sessions.get(id)?.plan;
    const req = pendingRevision(plan ?? null);
    if (!plan || !req) return null;
    const next = markRevisionDelivered(plan);
    this.mutate(id, (s) => {
      s.plan = next;
    });
    this.persistNow(id);
    return { prompt: req.prompt, marker: REVISION_MARKER };
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
    // Raised before anyone listens (a save that failed as the store loaded,
    // in its constructor): held for the first listener, the daemon's log.
    // While some are held, a later one waits behind them, in order.
    if (this.listenerCount('event') === 0 || (this.unheard.length && event.type === 'persist-error')) {
      if (event.type !== 'persist-error') return;
      this.unheard.push(event);
      this.passOnHeld();
      return;
    }
    this.emit('event', event);
  }

  /** The first 'event' listener: told what was held, once it is on
   *  (newListener comes just before). */
  private readonly onListener = (name: string | symbol): void => {
    if (name !== 'event') return;
    this.off('newListener', this.onListener);
    this.flushSoon();
  };

  private flushPending = false;

  /** What was held, told on the next tick, one at a time and in order: one
   *  raised meanwhile waits behind them (and is told in the same pass).
   *  What is still held after it (the listener gone part way, or one that
   *  threw: its event is gone, as a live one would be) goes on. */
  private flushSoon(): void {
    if (this.flushPending) return;
    this.flushPending = true;
    process.nextTick(() => {
      try {
        while (this.unheard.length && this.listenerCount('event')) this.emit('event', this.unheard.shift()!);
      } finally {
        this.flushPending = false;
        this.passOnHeld();
      }
    });
  }

  /** What is held, on its way: told soon while someone listens, else
   *  waiting for the first listener (once). */
  private passOnHeld(): void {
    if (!this.unheard.length) return;
    if (this.listenerCount('event') > 0) this.flushSoon();
    else if (!this.listeners('newListener').includes(this.onListener)) this.on('newListener', this.onListener);
  }

  /** Every listener off, the one waiting for the first too: it waits again
   *  while anything is held. */
  override removeAllListeners(name?: string | symbol): this {
    // No name is every name: passed on as none, not as undefined.
    if (name === undefined) super.removeAllListeners();
    else super.removeAllListeners(name);
    this.passOnHeld();
    return this;
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

/** `review`: the project's review mode (the daemon's `reviewFor`), else the default. */
export function summarize(s: SessionState, review: ReviewMode = DEFAULT_BUILD_SETTINGS.review): SessionSummary {
  const plan = s.plan;
  return {
    sessionId: s.sessionId,
    agent: s.agent,
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
    phase: planPhase(plan),
    planStatus: planStatus(plan, review),
    awaitingReview: awaitingUserReview(plan, review).length,
    current: currentTask(plan)?.title ?? null,
    waiting: s.waiting,
    surface: s.surface,
    link: s.link,
    openThreads: plan?.threads.filter((t) => !t.resolved).length ?? 0,
    unreadByClaude: unreadItems(plan),
    // A plan saved before sessions were stamped still counts, and so does
    // a newer build's session: blank here, but one it kept.
    engaged: Boolean(s.engagedAt) || plan !== null || Boolean(s.savedByNewer),
    hooked: s.hookedAt !== null,
    ...(s.savedByNewer ? { savedByNewer: true } : {}),
  };
}

/** Write a session's state into its folder, made if need be: on disk
 *  before it replaces the old file, so a power cut between the two leaves
 *  the old state, not an empty new one. */
function writeState(dir: string, state: SessionState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    // writeFileSync on a descriptor loops until every byte is written;
    // a single writeSync may stop short.
    writeFileSync(fd, JSON.stringify({ schemaVersion: STATE_SCHEMA, ...state }, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path.join(dir, 'state.json'));
}

/** The state file an earlier build kept a session in, where that is not its own. */
function legacyFile(id: string): string | null {
  const old = legacyName(id);
  return old === sanitizeId(id) ? null : path.join(paths.sessionsDir(), old, 'state.json');
}

/** Whose session a state file holds, if it can be read: looked at only,
 *  never moved aside, whosever folder it is in. */
function ownerOf(file: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(file, 'utf8')) as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** States read with no time of their own, dated by their file's: to be
 *  saved with that date. */
const datedByFile = new WeakSet<SessionState>();

/**
 * Read one session's state, or undefined if there is none.
 *
 * A file that exists but cannot be read is moved aside rather than ignored:
 * ignoring it would let the next save write a blank session over the top of
 * a plan that might still be recoverable by hand.
 */
function readState(file: string): SessionState | typeof NEWER | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as SessionState & { schemaVersion?: unknown };
    if (!state || typeof state !== 'object' || typeof state.sessionId !== 'string') throw new Error('not a session');
    // A newer build's format may mean something this one cannot see — a
    // submission it would read as invalid, and so as unlocked. Hands off.
    if (typeof state.schemaVersion === 'number' && state.schemaVersion > STATE_SCHEMA) return NEWER;
    delete state.schemaVersion;
    // Only ever set in memory: on disk it would stop this one being saved.
    delete state.savedByNewer;
    // One with no time of its own was last saved when its file was: saved
    // with it once loaded (datedByFile), so a copy of the file keeps it.
    if (typeof state.updatedAt !== 'number') datedByFile.add(state);
    migrate(state, () => mtimeOf(file));
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
function migrate(state: SessionState, savedAt: () => number): void {
  const raw = state as unknown as Record<string, unknown>;
  state.updatedAt = typeof state.updatedAt === 'number' ? state.updatedAt : savedAt();
  state.createdAt ??= state.updatedAt;
  state.title = typeof state.title === 'string' && state.title ? state.title : state.sessionId.slice(0, 8);
  state.cwd = typeof state.cwd === 'string' ? state.cwd : '';
  if (state.status !== 'ended') state.status = 'idle';

  const oldPlan = raw['plan'] as Record<string, unknown> | null | undefined;
  if (oldPlan && !Array.isArray(oldPlan['tasks'])) {
    const plan = emptyPlan(String(oldPlan['title'] ?? state.title));
    plan.summary = typeof oldPlan['summary'] === 'string' ? oldPlan['summary'] : '';
    if (typeof oldPlan['markdown'] === 'string' && oldPlan['markdown'].trim()) {
      plan.sections.push({ id: 's1', title: 'Notes', body: oldPlan['markdown'], rev: 1, updatedAt: state.updatedAt, updatedBy: 'claude' });
    }
    const steps = Array.isArray(oldPlan['steps']) ? (oldPlan['steps'] as Record<string, unknown>[]) : [];
    // Dated as the session is: they were saved with it.
    steps.forEach((step, i) => {
      const now = state.updatedAt;
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
  // Sessions saved before Coplan worked with agents other than Claude Code.
  state.agent = isAgentKind(state.agent) ? state.agent : DEFAULT_AGENT;
  // Saved before hooks were recorded: nothing says they did not run.
  if (state.hookedAt === undefined) state.hookedAt = state.createdAt;

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

/** The repository's `planCheck` errors hold the sign-off: what the user
 *  would sign is a plan their own rules say is not finished. */
function refuseBlockingGaps(plan: Plan, input: PromptOptions, what: 'confirmed' | 'submitted'): void {
  const held = blockingGaps(plan, input.project?.planCheck);
  if (!held.length) return;
  const list = held.slice(0, 5).map((g) => `- ${g.message}`).join('\n');
  throw new PlanError(
    `The plan cannot be ${what} yet: this repository's plan check (planCheck in .coplan/config.json) counts ` +
      `${held.length === 1 ? 'this gap' : `these ${held.length} gaps`} as errors:\n${list}${held.length > 5 ? `\n- …and ${held.length - 5} more` : ''}`,
  );
}

function discardDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* not worth failing over */
  }
}
