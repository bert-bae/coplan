/**
 * What happened on a pull request, read from the forge's API.
 *
 * A watched pull request is polled; each poll is a snapshot of it (the
 * GitHub REST shapes, as `gh api` returns them), and `prEvents` turns the
 * difference between that snapshot and the cursor left by the last one into
 * events. Pure: no I/O, so every case is a fixture.
 *
 * The first poll of a pull request (no cursor) is a baseline: it reports
 * the conditions it finds — failing CI, a conflict, merged — but not the
 * comments and reviews made before Coplan was watching.
 */

export const PR_EVENT_KINDS = [
  'ci_failed',
  'ci_passed',
  'changes_requested',
  'approved',
  'review_comment',
  'comment',
  'merge_conflict',
  'behind_base',
  'merged',
  'closed',
  'reopened',
] as const;
export type PrEventKind = (typeof PR_EVENT_KINDS)[number];

export interface PrEvent {
  kind: PrEventKind;
  /** Unique per pull request: what the timeline and de-duplication key on. */
  id: string;
  pr: number;
  author?: string;
  /** The author's standing on the repository, as GitHub says it:
   *  `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, … */
  association?: string;
  /** The comment or review text, cut to MAX_BODY. Untrusted. */
  body?: string;
  url?: string;
  at?: string;
  /** For an inline comment: where. */
  path?: string;
  line?: number;
  /** The head commit it is about (CI events). */
  sha?: string;
  /** For CI events: the checks that decided it. */
  checks?: { name: string; conclusion: string | null; url?: string }[];
}

/** CI on one head commit, folded from its check runs. */
export type CiState = 'pending' | 'failed' | 'passed';

/** What the last poll saw, stored with the branch between polls. */
export interface PrCursor {
  /** Highest id seen per kind: GitHub ids only grow, so this bounds the cursor. */
  lastReview?: number;
  lastReviewComment?: number;
  lastIssueComment?: number;
  ci?: { sha: string; state: CiState };
  mergeable?: string;
  state?: 'open' | 'merged' | 'closed';
  /** Who opened the pull request: what `watch.trust: "author"` trusts. */
  author?: string;
}

/* GitHub REST shapes, the fields read. */
interface GhUser {
  login?: string;
}
type Assoc = { author_association?: string };
export interface GhSnapshot {
  pr: {
    number: number;
    state: 'open' | 'closed' | string;
    merged?: boolean;
    merged_at?: string | null;
    html_url?: string;
    /** `clean`, `dirty` (conflict), `behind`, `blocked`, `unknown`, … */
    mergeable_state?: string;
    head: { sha: string };
    /** Who opened it. */
    user?: GhUser | null;
  };
  /** `GET /repos/{o}/{r}/commits/{sha}/check-runs` → `.check_runs`. */
  checkRuns?: { id: number; name: string; status: string; conclusion: string | null; html_url?: string; head_sha?: string }[];
  reviews?: ({ id: number; user?: GhUser | null; state: string; body?: string | null; submitted_at?: string; html_url?: string } & Assoc)[];
  reviewComments?: ({ id: number; user?: GhUser | null; body?: string; path?: string; line?: number | null; html_url?: string; created_at?: string } & Assoc)[];
  issueComments?: ({ id: number; user?: GhUser | null; body?: string; html_url?: string; created_at?: string } & Assoc)[];
}

export const MAX_BODY = 4_000;
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** CI on `sha`: failed once any run failed, passed once all finished well,
 *  pending while any runs; undefined with no runs at all. */
export function ciState(runs: GhSnapshot['checkRuns'], sha: string): CiState | undefined {
  // github.ts maps legacy commit statuses onto check runs, so both count here.
  const mine = (runs ?? []).filter((r) => !r.head_sha || r.head_sha === sha);
  if (!mine.length) return undefined;
  if (mine.some((r) => r.status === 'completed' && FAILED.has(r.conclusion ?? ''))) return 'failed';
  return mine.every((r) => r.status === 'completed') ? 'passed' : 'pending';
}

/**
 * The events between `cursor` and `snap`, and the cursor to keep.
 * `self` is the login Coplan acts as: its own replies are not events, or a
 * fix's reply would start the next fix.
 */
export function prEvents(snap: GhSnapshot, cursor: PrCursor | undefined, opts: { self?: string } = {}): { events: PrEvent[]; cursor: PrCursor } {
  const pr = snap.pr.number;
  const baseline = !cursor;
  const was = cursor ?? {};
  const events: PrEvent[] = [];
  const next: PrCursor = { ...was };
  const body = (text: string | null | undefined) => (text ? text.slice(0, MAX_BODY) : undefined);
  const foreign = (user: GhUser | null | undefined) => !opts.self || user?.login !== opts.self;
  const clean = <T extends object>(e: T): T => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as T;

  // Comments and reviews: anything newer than the last seen id.
  const fresh = <T extends { id: number }>(list: T[] | undefined, last: number | undefined): { items: T[]; max: number | undefined } => {
    const items = (list ?? []).filter((x) => last === undefined || x.id > last).sort((a, b) => a.id - b.id);
    const max = Math.max(last ?? -Infinity, ...(list ?? []).map((x) => x.id));
    return { items: baseline ? [] : items, max: Number.isFinite(max) ? max : last };
  };

  const reviews = fresh(snap.reviews, was.lastReview);
  next.lastReview = reviews.max;
  for (const r of reviews.items) {
    if (!foreign(r.user)) continue;
    const kind: PrEventKind | null =
      r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes_requested' : r.state === 'COMMENTED' && r.body?.trim() ? 'comment' : null;
    if (kind) events.push(clean({ kind, id: `review:${r.id}`, pr, author: r.user?.login, association: r.author_association, body: body(r.body), url: r.html_url, at: r.submitted_at }));
  }

  const inline = fresh(snap.reviewComments, was.lastReviewComment);
  next.lastReviewComment = inline.max;
  for (const c of inline.items) {
    if (!foreign(c.user)) continue;
    events.push(
      clean({ kind: 'review_comment' as const, id: `rc:${c.id}`, pr, author: c.user?.login, association: c.author_association, body: body(c.body), url: c.html_url, at: c.created_at, path: c.path, line: c.line ?? undefined }),
    );
  }

  const talk = fresh(snap.issueComments, was.lastIssueComment);
  next.lastIssueComment = talk.max;
  for (const c of talk.items) {
    if (!foreign(c.user)) continue;
    events.push(clean({ kind: 'comment' as const, id: `ic:${c.id}`, pr, author: c.user?.login, association: c.author_association, body: body(c.body), url: c.html_url, at: c.created_at }));
  }

  // CI: per head commit, so a new push that fails again is a new failure.
  const sha = snap.pr.head.sha;
  const ci = ciState(snap.checkRuns, sha);
  if (ci && (was.ci?.sha !== sha || was.ci.state !== ci)) {
    if (ci !== 'pending') {
      const decided = (snap.checkRuns ?? []).filter((r) => (!r.head_sha || r.head_sha === sha) && (ci === 'passed' || FAILED.has(r.conclusion ?? '')));
      events.push({
        kind: ci === 'failed' ? 'ci_failed' : 'ci_passed',
        id: `ci:${sha}:${ci}`,
        pr,
        sha,
        checks: decided.map((r) => clean({ name: r.name, conclusion: r.conclusion, url: r.html_url })),
      });
    }
    next.ci = { sha, state: ci };
  } else if (!ci && was.ci?.sha !== sha) {
    delete next.ci;
  }

  // Mergeability: on entering a state, not on every poll that sees it.
  const m = snap.pr.mergeable_state;
  if (m && m !== 'unknown') {
    if (m !== was.mergeable && (m === 'dirty' || m === 'behind')) {
      events.push({ kind: m === 'dirty' ? 'merge_conflict' : 'behind_base', id: `mergeable:${sha}:${m}`, pr, sha });
    }
    next.mergeable = m;
  }

  const state = snap.pr.merged || snap.pr.merged_at ? 'merged' : snap.pr.state === 'closed' ? 'closed' : 'open';
  if (state !== (was.state ?? 'open')) {
    events.push(clean({ kind: state === 'open' ? ('reopened' as const) : state, id: `state:${state}:${sha}`, pr, url: snap.pr.html_url }));
  }
  next.state = state;
  if (snap.pr.user?.login) next.author = snap.pr.user.login;

  return { events, cursor: next };
}

/** An event waiting to be dispatched, with when it arrived. */
export interface QueuedEvent {
  event: PrEvent;
  receivedAt: number;
}

/**
 * Whether a pull request's waiting events are due as one batch: once quiet
 * for `debounceSec`, so a 12-comment review is one fix pass. A merge or
 * close goes at once, and a stream that never pauses goes after ten quiet
 * periods rather than never.
 */
export function batchDue(queue: readonly QueuedEvent[], now: number, debounceSec: number): boolean {
  if (!queue.length) return false;
  if (queue.some((q) => q.event.kind === 'merged' || q.event.kind === 'closed')) return true;
  const quiet = debounceSec * 1000;
  const first = Math.min(...queue.map((q) => q.receivedAt));
  const last = Math.max(...queue.map((q) => q.receivedAt));
  return now - last >= quiet || now - first >= quiet * 10;
}
