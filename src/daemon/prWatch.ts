import type { ProjectConfig, PrWatch } from '../shared/project.ts';
import { prEvents, type GhSnapshot } from '../shared/prEvents.ts';
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
 * Watching stops when the plan records it merged or closed, or a poll finds
 * it so.
 */

// shortcut: only sessions in memory are watched; an ended session is evicted after 6h and stops being watched — keep watched ones in memory if PRs outlive their sessions.

export const MAX_QUEUE = 200;
/** After this long with nothing new on it, a pull request is looked at less often. */
export const QUIET_MS = 24 * 60 * 60 * 1000;
const QUIET_INTERVAL_S = 300;
const MAX_BACKOFF_S = 1800;

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
      if (seen?.pr === ref.number && seen.cursor?.state && seen.cursor.state !== 'open') continue;
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
    } finally {
      this.running = false;
    }
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
