import type { ProjectConfig, PrWatch } from '../shared/project.ts';
import { PR_EVENT_KINDS, batchDue, prEvents, type GhSnapshot, type PrEvent, type PrEventKind } from '../shared/prEvents.ts';
import { PR_MARKER, dispatch } from '../shared/prDispatch.ts';
import { stackStatus } from '../shared/build.ts';
import { PlanError } from '../shared/plan.ts';
import type { PrWatchState, SessionState } from '../shared/types.ts';
import { fetchPr, prRef, type PrRef } from './github.ts';
import type { SessionStore } from './store.ts';

/**
 * Following the pull requests a build recorded until they merge.
 *
 * A pull request is watched while its plan records it open or draft
 * (`harness_branch_update`), the repository's `pullRequests.watch.enabled`
 * holds and it opens them with a tool (not `none`). Each poll's events are
 * queued on the session, by branch, for the dispatcher; the cursor is saved
 * with the session, so a restarted daemon picks up where this one stopped.
 * Watching stops when the plan records it merged or closed, a poll finds
 * it so, or it is stopped by hand (`coplan pr unwatch`).
 *
 * Each pull request's queue goes, once due (`watch.debounce`), through the
 * dispatcher (prDispatch.ts); what needs the agent lands in the session's
 * inbox, which `coplan pr wait`, harness_pr_events or the user's next
 * message takes. A merge or close a poll sees is recorded on the plan.
 */

// shortcut: only sessions in memory are watched; an ended session is evicted after 6h and stops being watched — keep watched ones in memory if PRs outlive their sessions.

export const MAX_QUEUE = 200;
/** After this long with nothing new on it, a pull request is looked at less often. */
export const QUIET_MS = 24 * 60 * 60 * 1000;
const QUIET_INTERVAL_S = 300;
const MAX_BACKOFF_S = 1800;
export const MAX_INBOX = 20;
const MAX_TIMELINE = 50;

export interface Watched {
  session: SessionState;
  branch: string;
  ref: PrRef;
  watch: PrWatch;
}

export interface WatchDeps {
  store: SessionStore;
  project: (root: string) => ProjectConfig;
  fetch?: (ref: PrRef, cwd: string) => Promise<{ snapshot: GhSnapshot; viewer?: string }>;
  log: (message: string) => void;
  now?: () => number;
}

/** Every pull request that should be watched now. */
export function watchedPrs(sessions: readonly SessionState[], project: (root: string) => ProjectConfig): Watched[] {
  const out: Watched[] = [];
  for (const session of sessions) {
    if (!session.plan?.branches || !session.repoRoot) continue;
    const { tool, watch } = project(session.repoRoot).pullRequests;
    if (!watch.enabled || tool === 'none') continue;
    for (const [branch, state] of Object.entries(session.plan.branches)) {
      const pr = state.pr;
      if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) continue;
      const ref = prRef(pr);
      if (!ref) continue;
      const seen = session.prWatch?.[branch];
      // The plan may not have caught up with a merge a poll already saw.
      if (seen?.pr === ref.number && (seen.stopped || (seen.cursor?.state && seen.cursor.state !== 'open'))) continue;
      out.push({ session, branch, ref, watch });
    }
  }
  return out;
}

/** Seconds until the next poll: the interval, longer after failures or a day of quiet. */
export function pollInterval(state: PrWatchState | undefined, watch: PrWatch, now: number): number {
  if (state?.failures) return Math.min(watch.interval * 2 ** state.failures, MAX_BACKOFF_S);
  const last = state ? (state.lastEventAt ?? state.since) : now;
  return now - last >= QUIET_MS ? Math.max(watch.interval, QUIET_INTERVAL_S) : watch.interval;
}

export class PrWatcher {
  private running = false;
  /** Who is waiting on each session's inbox (`coplan pr wait`). */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: WatchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  watched(): Watched[] {
    return watchedPrs(this.deps.store.all(), this.deps.project);
  }

  /** Polls every watched pull request that is due; one tick at a time. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const w of this.watched()) {
        const state = this.current(w);
        const now = this.now();
        if (state?.checkedAt && now - state.checkedAt < pollInterval(state, w.watch, now) * 1000) continue;
        await this.poll(w, state);
      }
      this.flush();
    } finally {
      this.running = false;
    }
  }

  /** Dispatches each pull request's queue that is due — every one, with `force`. */
  flush(force = false, only?: { id: string; branch: string }): void {
    const now = this.now();
    for (const session of this.deps.store.all()) {
      if (!session.repoRoot || (only && only.id !== session.sessionId)) continue;
      for (const [branch, state] of Object.entries(session.prWatch ?? {})) {
        if (!state.queue.length || (only && only.branch !== branch)) continue;
        const project = this.deps.project(session.repoRoot);
        if (!force && !batchDue(state.queue, now, project.pullRequests.watch.debounce)) continue;
        this.dispatchBatch(session.sessionId, branch, project, now);
      }
    }
  }

  private dispatchBatch(id: string, branch: string, project: ProjectConfig, now: number): void {
    const { store } = this.deps;
    const session = store.get(id)!;
    const state = session.prWatch![branch]!;
    const events = state.queue.map((q) => q.event);
    const pr = session.plan?.branches?.[branch]?.pr;
    const { on, watch } = project.pullRequests;
    const out = dispatch({ pr: state.pr, branch, ...(pr?.url ? { url: pr.url } : {}), events, on, watch, ...(state.cursor?.author ? { prAuthor: state.cursor.author } : {}), fixRounds: state.fixRounds ?? 0 });
    store.mutate(id, (s) => {
      const st = s.prWatch![branch]!;
      st.queue = [];
      if (out.fixRound) st.fixRounds = (st.fixRounds ?? 0) + 1;
      st.timeline = [...(st.timeline ?? []), { at: now, note: out.note }].slice(-MAX_TIMELINE);
    });
    const prompts = [out.prompt];
    // A merge or close is a fact, recorded whatever `on` says; `advance` says what follows it.
    const end = events.findLast((e) => e.kind === 'merged' || e.kind === 'closed' || e.kind === 'reopened');
    if (end && pr && end.kind !== 'reopened' && pr.state !== end.kind) {
      const { plan } = store.applyOps(id, [{ op: 'set_branch', branch, pr: { ...pr, state: end.kind } }], 'claude', { tracking: true });
      if (end.kind === 'merged' && on.merged.includes('advance')) {
        const restacks = stackStatus(plan, project.branches.base).filter((s) => s.restack).map((s) => `- ${s.restack}`);
        const open = Object.values(plan.branches ?? {}).filter((b) => b.pr && b.pr.state !== 'merged' && b.pr.state !== 'closed');
        if (restacks.length) prompts.push(`${PR_MARKER} #${state.pr} (\`${branch}\`) merged, so the stack moved:\n${restacks.join('\n')}`);
        else if (!open.length) prompts.push(`${PR_MARKER} #${state.pr} (\`${branch}\`) merged. Every pull request of this plan is merged or closed: tell the user the plan has landed.`);
      }
    }
    const prompt = prompts.filter(Boolean).join('\n\n');
    if (prompt) this.push(id, prompt);
  }

  /** Puts a prompt in the session's inbox and wakes whoever waits on it. */
  push(id: string, prompt: string): void {
    this.deps.store.mutate(id, (s) => {
      s.prInbox = [...(s.prInbox ?? []), prompt].slice(-MAX_INBOX);
    });
    this.deps.store.persistNow(id);
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  /** Takes what waits in the inbox, oldest first, up to `max` characters (always at least one). */
  take(id: string, max = Infinity): string | null {
    const inbox = this.deps.store.get(id)?.prInbox ?? [];
    if (!inbox.length) return null;
    let n = 1;
    let size = inbox[0]!.length;
    while (n < inbox.length && size + inbox[n]!.length + 2 <= max) size += inbox[n++]!.length + 2;
    this.deps.store.mutate(id, (s) => {
      const rest = (s.prInbox ?? []).slice(n);
      if (rest.length) s.prInbox = rest;
      else delete s.prInbox;
    });
    this.deps.store.persistNow(id);
    return inbox.slice(0, n).join('\n\n');
  }

  /** What waits in the inbox, or the next thing to arrive within `ms`; null at the timeout. */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<string | null> {
    const now = this.take(id);
    if (now || signal?.aborted) return Promise.resolve(now);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (value: string | null) => {
        clearTimeout(timer);
        set.delete(wake);
        if (!set.size) this.waiters.delete(id);
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const wake = () => done(this.take(id));
      const abort = () => done(null);
      const timer = setTimeout(abort, ms);
      set.add(wake);
      signal?.addEventListener('abort', abort);
    });
  }

  /**
   * An event the agent saw itself (a cloud session's own pull request
   * subscription), dispatched at once: the agent batches what it reports.
   */
  report(id: string, branch: string, input: Omit<PrEvent, 'id' | 'pr' | 'kind'> & { kind: string }): void {
    const session = this.deps.store.get(id);
    const pr = session?.plan?.branches?.[branch]?.pr;
    const ref = pr ? prRef(pr) : null;
    if (!session?.repoRoot || !ref) throw new PlanError(`\`${branch}\` has no pull request recorded: record it first with harness_branch_update {branch, pr_url, pr_number, pr_state}.`);
    if (!(PR_EVENT_KINDS as readonly string[]).includes(input.kind)) throw new PlanError(`kind must be one of ${PR_EVENT_KINDS.join(', ')}.`);
    const now = this.now();
    const event = { ...input, kind: input.kind as PrEventKind, id: `agent:${now}:${Math.random().toString(36).slice(2, 8)}`, pr: ref.number };
    this.deps.store.mutate(id, (s) => {
      const prev = s.prWatch?.[branch];
      const base: PrWatchState = prev?.pr === ref.number ? prev : { pr: ref.number, since: now, queue: [] };
      s.prWatch = { ...s.prWatch, [branch]: { ...base, queue: [...base.queue, { event, receivedAt: now }].slice(-MAX_QUEUE), lastEventAt: now } };
    });
    this.flush(true, { id, branch });
  }

  /** Stops watching one branch's pull request, or all of the session's. How many stopped. */
  unwatch(id: string, branch?: string): number {
    const session = this.deps.store.get(id);
    const targets = Object.entries(session?.plan?.branches ?? {}).filter(([b, st]) => (!branch || b === branch) && st.pr && prRef(st.pr));
    if (!targets.length) return 0;
    const now = this.now();
    this.deps.store.mutate(id, (s) => {
      for (const [b, st] of targets) {
        const number = prRef(st.pr!)!.number;
        const prev = s.prWatch?.[b];
        s.prWatch = { ...s.prWatch, [b]: { ...(prev?.pr === number ? prev : { pr: number, since: now, queue: [] }), stopped: true } };
      }
    });
    return targets.length;
  }

  /** What is kept for this branch — unless it is about another pull request. */
  private current(w: Watched): PrWatchState | undefined {
    const state = w.session.prWatch?.[w.branch];
    return state?.pr === w.ref.number ? state : undefined;
  }

  private async poll(w: Watched, prev: PrWatchState | undefined): Promise<void> {
    const { store, log } = this.deps;
    const id = w.session.sessionId;
    const base: PrWatchState = prev ?? { pr: w.ref.number, since: this.now(), queue: [] };
    let next: PrWatchState;
    try {
      const { snapshot, viewer } = await (this.deps.fetch ?? fetchPr)(w.ref, w.session.repoRoot!);
      const { events, cursor } = prEvents(snapshot, prev?.cursor, viewer ? { self: viewer } : {});
      const now = this.now();
      if (events.length) log(`pull request #${w.ref.number} (${w.branch}): ${events.map((e) => e.kind).join(', ')}`);
      if (!events.length && prev && !prev.error && JSON.stringify(cursor) === JSON.stringify(prev.cursor)) {
        // Nothing new: noted in memory only, so a quiet poll writes nothing.
        prev.checkedAt = now;
        return;
      }
      const { error: _e, failures: _f, ...rest } = base;
      next = {
        ...rest,
        cursor,
        checkedAt: now,
        queue: [...base.queue, ...events.map((event) => ({ event, receivedAt: now }))].slice(-MAX_QUEUE),
        ...(events.length ? { lastEventAt: now } : {}),
      };
    } catch (err) {
      const error = (err as Error).message;
      if (error !== prev?.error) log(`pull request #${w.ref.number} (${w.branch}) could not be read: ${error}`);
      next = { ...base, checkedAt: this.now(), error, failures: (base.failures ?? 0) + 1 };
      if (error === prev?.error) {
        // The same failure again: counted in memory, not written each time.
        Object.assign(prev, { checkedAt: next.checkedAt, failures: next.failures });
        return;
      }
    }
    store.mutate(id, (s) => {
      s.prWatch = { ...s.prWatch, [w.branch]: next };
    });
  }
}
