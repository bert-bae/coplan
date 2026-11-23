import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY, batchDue, ciState, prEvents, type GhSnapshot, type PrCursor, type QueuedEvent } from '../shared/prEvents.ts';

/**
 * A watched pull request's polls, as `gh api` returns them, turned into
 * events: each kind once, nothing from a replayed poll, nothing Coplan
 * said itself, and a burst batched into one dispatch.
 */

const snap = (over: Omit<Partial<GhSnapshot>, 'pr'> & { pr?: Partial<GhSnapshot['pr']> } = {}): GhSnapshot => ({
  ...over,
  pr: { number: 7, state: 'open', head: { sha: 'aaa' }, mergeable_state: 'clean', html_url: 'https://github.com/o/r/pull/7', ...over.pr },
});
const run = (id: number, name: string, status: string, conclusion: string | null, head_sha = 'aaa') => ({ id, name, status, conclusion, head_sha, html_url: `https://ci/${id}` });
const kinds = (r: { events: { kind: string }[] }) => r.events.map((e) => e.kind);

test('the first poll is a baseline: conditions, not history', () => {
  const r = prEvents(
    snap({
      checkRuns: [run(1, 'tests', 'completed', 'failure')],
      issueComments: [{ id: 50, user: { login: 'bob' }, body: 'old' }],
      reviews: [{ id: 9, user: { login: 'bob' }, state: 'APPROVED' }],
      pr: { mergeable_state: 'dirty' },
    }),
    undefined,
  );
  assert.deepEqual(kinds(r), ['ci_failed', 'merge_conflict']);
  assert.deepEqual(r.cursor, { lastReview: 9, lastIssueComment: 50, lastReviewComment: undefined, ci: { sha: 'aaa', state: 'failed' }, mergeable: 'dirty', state: 'open' });
});

test('each kind of event, once; a replayed poll yields nothing', () => {
  const cursor: PrCursor = { lastReview: 1, lastReviewComment: 1, lastIssueComment: 1, ci: { sha: 'aaa', state: 'pending' }, mergeable: 'clean', state: 'open' };
  const s = snap({
    checkRuns: [run(1, 'tests', 'completed', 'failure'), run(2, 'lint', 'completed', 'success')],
    reviews: [
      { id: 2, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Please split this.' },
      { id: 3, user: { login: 'carol' }, state: 'APPROVED' },
      { id: 4, user: { login: 'carol' }, state: 'COMMENTED', body: '' },
      { id: 5, user: { login: 'carol' }, state: 'PENDING', body: 'draft' },
    ],
    reviewComments: [{ id: 2, user: { login: 'bob' }, body: 'Use a map.', path: 'src/a.ts', line: 12, html_url: 'https://x/rc2' }],
    issueComments: [{ id: 2, user: { login: 'dave' }, body: 'Any news?' }],
    pr: { mergeable_state: 'behind' },
  });
  const first = prEvents(s, cursor);
  assert.deepEqual(kinds(first), ['changes_requested', 'approved', 'review_comment', 'comment', 'ci_failed', 'behind_base']);
  const inline = first.events.find((e) => e.kind === 'review_comment')!;
  assert.deepEqual(inline, { kind: 'review_comment', id: 'rc:2', pr: 7, author: 'bob', body: 'Use a map.', url: 'https://x/rc2', path: 'src/a.ts', line: 12 });
  assert.deepEqual(first.events.find((e) => e.kind === 'ci_failed')!.checks, [{ name: 'tests', conclusion: 'failure', url: 'https://ci/1' }], 'only the checks that failed');
  assert.deepEqual(prEvents(s, first.cursor).events, [], 'the same poll again is nothing new');
});

test("Coplan's own replies are not events, or a fix's reply would start the next fix", () => {
  const r = prEvents(
    snap({ issueComments: [{ id: 3, user: { login: 'coplan-bot' }, body: 'Fixed in abc.' }, { id: 4, user: { login: 'bob' }, body: 'Thanks' }] }),
    { lastIssueComment: 2, state: 'open' },
    { self: 'coplan-bot' },
  );
  assert.deepEqual(r.events.map((e) => e.id), ['ic:4']);
  assert.equal(r.cursor.lastIssueComment, 4, 'still counted as seen');
});

test('CI is per head commit: a push that fails again is a new failure; pending is no event', () => {
  let c: PrCursor = { state: 'open' };
  c = prEvents(snap({ checkRuns: [run(1, 'tests', 'completed', 'failure')] }), c).cursor;
  const pushed = snap({ pr: { head: { sha: 'bbb' } }, checkRuns: [run(2, 'tests', 'in_progress', null, 'bbb')] });
  const pending = prEvents(pushed, c);
  assert.deepEqual(pending.events, []);
  assert.deepEqual(pending.cursor.ci, { sha: 'bbb', state: 'pending' });
  const failedAgain = prEvents(snap({ pr: { head: { sha: 'bbb' } }, checkRuns: [run(2, 'tests', 'completed', 'timed_out', 'bbb')] }), pending.cursor);
  assert.deepEqual(failedAgain.events.map((e) => e.id), ['ci:bbb:failed']);
  const passed = prEvents(snap({ pr: { head: { sha: 'ccc' } }, checkRuns: [run(3, 'tests', 'completed', 'success', 'ccc'), run(4, 'docs', 'completed', 'skipped', 'ccc')] }), failedAgain.cursor);
  assert.deepEqual(kinds(passed), ['ci_passed']);
});

test('ciState: runs of other commits do not count; none at all is no state', () => {
  assert.equal(ciState([run(1, 't', 'completed', 'failure', 'old')], 'aaa'), undefined);
  assert.equal(ciState([run(1, 't', 'completed', 'success'), run(2, 'u', 'queued', null)], 'aaa'), 'pending');
  assert.equal(ciState([run(1, 't', 'completed', 'neutral'), run(2, 'u', 'queued', null), run(3, 'v', 'completed', 'cancelled')], 'aaa'), 'failed', 'a failure is known before the rest finish');
});

test('conflicts and merge state are events on entering them, not on every poll', () => {
  const dirty = prEvents(snap({ pr: { mergeable_state: 'dirty' } }), { mergeable: 'clean', state: 'open' });
  assert.deepEqual(kinds(dirty), ['merge_conflict']);
  assert.deepEqual(prEvents(snap({ pr: { mergeable_state: 'unknown' } }), dirty.cursor).events, [], 'GitHub still computing is not a change');
  assert.equal(prEvents(snap({ pr: { mergeable_state: 'unknown' } }), dirty.cursor).cursor.mergeable, 'dirty');
  const merged = prEvents(snap({ pr: { state: 'closed', merged: true } }), { state: 'open' });
  assert.deepEqual(kinds(merged), ['merged']);
  const closed = prEvents(snap({ pr: { state: 'closed', merged_at: null } }), { state: 'open' });
  assert.deepEqual(kinds(closed), ['closed']);
  assert.deepEqual(kinds(prEvents(snap(), closed.cursor)), ['reopened']);
});

test('comment text is cut, so one comment cannot flood the prompt', () => {
  const r = prEvents(snap({ issueComments: [{ id: 2, user: { login: 'bob' }, body: 'x'.repeat(MAX_BODY + 50) }] }), { lastIssueComment: 1 });
  assert.equal(r.events[0]!.body!.length, MAX_BODY);
});

test('a 12-comment review is one batch: due once quiet, at once on merge, and never starved', () => {
  const q = (kind: 'review_comment' | 'merged', at: number): QueuedEvent => ({ event: { kind, id: `${kind}:${at}`, pr: 7 }, receivedAt: at });
  const burst = Array.from({ length: 12 }, (_, i) => q('review_comment', i * 1000));
  assert.equal(batchDue([], 1e9, 90), false);
  assert.equal(batchDue(burst, 11_000 + 89_000, 90), false, 'still inside the quiet period');
  assert.equal(batchDue(burst, 11_000 + 90_000, 90), true);
  assert.equal(batchDue([...burst, q('merged', 11_500)], 12_000, 90), true, 'a merge does not wait');
  const chatty = Array.from({ length: 30 }, (_, i) => q('review_comment', i * 60_000));
  assert.equal(batchDue(chatty, 29 * 60_000 + 1000, 90), true, 'after ten quiet periods it goes anyway');
});
