import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { SessionState } from '../shared/types.ts';

/**
 * The page's live stream. Each opening takes a fresh single-use ticket, so
 * when the stream drops the page opens it again itself, backing off, and
 * catches up on what it missed; it stops, saying so, once the daemon no
 * longer knows its token. And only the newest opening may land: a slow
 * ticket for a session the user already left never opens a stream, nor
 * breaks the one that is open.
 */

setupDom();

/** An EventSource the test drives: it records every stream the page opens. */
class FakeSource {
  static opened: FakeSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  param(name: string): string | null {
    return new URL(this.url, 'http://x').searchParams.get(name);
  }
}
Object.defineProperty(globalThis, 'EventSource', { value: FakeSource, writable: true, configurable: true });

// The page's timers, run by hand: a reconnect needs no real waiting. The
// delay a retry asks for is the last one set when the stream drops.
const timers = new Map<number, () => void>();
const delays: number[] = [];
let nextTimer = 1;
window.setTimeout = ((fn: () => void, ms?: number) => {
  delays.push(ms ?? 0);
  timers.set(nextTimer, fn);
  return nextTimer++;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  if (id !== undefined) timers.delete(id);
}) as typeof window.clearTimeout;
function runTimers(): void {
  const due = [...timers.values()];
  timers.clear();
  for (const fn of due) fn();
}

/** Let the page's promises settle until `done` holds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await settle();
  assert.ok(done(), `timed out waiting for ${what}`);
}
const settle = () => new Promise((r) => setImmediate(r));

let tickets = 0;
let sessionFetches = 0;
const freshTicket = () => ({ ticket: `t${++tickets}` });
/** How the next ticket request is answered: a ticket by default. */
let ticketAnswer: () => unknown = freshTicket;
stubFetch((route) => {
  if (route.startsWith('/api/events/ticket')) return ticketAnswer();
  if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
  if (route.startsWith('/api/session/')) {
    // Each fetch is told apart by its title, so a test can see which one the page shows.
    const now = Date.now();
    const id = decodeURIComponent(route.split('/')[3]!.split('?')[0]!);
    const session: SessionState = { sessionId: id, agent: 'claude', cwd: '/repo', repoRoot: '/repo', branch: 'main', title: `fetch ${++sessionFetches}`, status: 'idle', waiting: null, surface: 'unknown', link: null, createdAt: now, updatedAt: now, plan: null };
    return { session };
  }
  return { ok: true };
});

const { store } = await import('../ui/store.ts');
await store.init();
const latest = () => FakeSource.opened.at(-1)!;

/** A live stream for `id`, as a test's starting point: whatever the test before it left. */
async function liveStream(id: string): Promise<FakeSource> {
  ticketAnswer = freshTicket;
  const opened = FakeSource.opened.length;
  await store.selectSession(id, false);
  await until(() => FakeSource.opened.length > opened && latest().param('session') === id, `a stream for ${id}`);
  latest().onopen!();
  assert.equal(store.getState().connection, 'live');
  return latest();
}

test('a dropped stream is opened again with a fresh ticket, backing off, and catches up on what it missed', async () => {
  const first = await liveStream('s1');

  // The stream drops: closed here, and opened again a second later.
  first.onerror!();
  assert.ok(first.closed, 'the dropped stream is closed, not left to the browser to retry with a spent ticket');
  assert.equal(store.getState().connection, 'reconnecting');
  assert.equal(delays.at(-1), 1000);
  const fetched = sessionFetches;
  runTimers();
  await until(() => latest() !== first, 'the second stream');
  const second = latest();
  assert.notEqual(second.param('ticket'), first.param('ticket'), 'with a ticket of its own');
  assert.equal(second.param('session'), 's1');
  await until(() => sessionFetches > fetched && store.getState().session?.title === `fetch ${sessionFetches}`, 'the catch-up fetch to land');

  // It drops again before it opens: twice as long. Once open, the backoff starts over.
  second.onerror!();
  assert.equal(delays.at(-1), 2000);
  runTimers();
  await until(() => latest() !== second, 'the third stream');
  latest().onopen!();
  assert.equal(store.getState().connection, 'live');
  latest().onerror!();
  assert.equal(delays.at(-1), 1000);
});

test('a page the daemon no longer knows stops reconnecting, and says so', async (t) => {
  t.after(() => {
    ticketAnswer = freshTicket;
  });
  const live = await liveStream('s1');
  ticketAnswer = () => ({ __status: 401, error: 'Unauthorized' });
  live.onerror!();
  runTimers();
  await until(() => store.getState().connection === 'unauthorized', 'the unauthorized state');
  const opened = FakeSource.opened.length;
  const asked = tickets;
  runTimers();
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(FakeSource.opened.length, opened, 'no stream is opened');
  assert.equal(tickets, asked, 'and no ticket asked for: nothing retries');
});

test('a slow ticket for a session the user already left never opens a stream, nor breaks the open one', async (t) => {
  t.after(() => {
    ticketAnswer = freshTicket;
  });
  await liveStream('s1');
  // Tickets handed out by hand, so the first one asked for lands last.
  const pending: { resolve: (value: unknown) => void; reject: (err: Error) => void }[] = [];
  ticketAnswer = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const opened = FakeSource.opened.length;
  void store.selectSession('s2', false);
  void store.selectSession('s3', false);
  void store.selectSession('s4', false);
  await until(() => pending.length === 3, 'three ticket requests');
  pending[2]!.resolve({ ticket: 'for-s4' });
  await until(() => FakeSource.opened.length === opened + 1, 'the stream for s4');
  const s4 = latest();
  s4.onopen!();

  // A late ticket for s2 lands, and a late failure for s3: neither may touch s4's stream.
  const timersBefore = delays.length;
  pending[0]!.resolve({ ticket: 'for-s2' });
  pending[1]!.reject(new Error('network down'));
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(FakeSource.opened.length, opened + 1, 'the late ticket for s2 opens nothing');
  assert.equal(s4.param('session'), 's4');
  assert.equal(s4.closed, false, "and s4's stream stays open");
  assert.equal(store.getState().connection, 'live', 'with the page still live');
  assert.equal(delays.length, timersBefore, 'and no retry set off by the late failure');
});
