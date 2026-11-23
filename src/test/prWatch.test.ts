import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GhSnapshot } from '../shared/prEvents.ts';
import { DEFAULT_PR_ON, DEFAULT_PR_WATCH, emptyProjectConfig, type ProjectConfig } from '../shared/project.ts';
import type { PrState } from '../shared/types.ts';

/**
 * Watching the pull requests a build recorded: recording one starts it,
 * recording it merged (or a poll finding it so) stops it, and a restarted
 * daemon picks up from the saved cursor.
 */

let home: string;
before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'coplan-prwatch-'));
  process.env['CC_HARNESS_HOME'] = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const project = (over: Partial<ProjectConfig['pullRequests']> = {}): ProjectConfig => {
  const p = emptyProjectConfig();
  p.pullRequests = { ...p.pullRequests, watch: { ...DEFAULT_PR_WATCH }, on: { ...DEFAULT_PR_ON }, ...over };
  return p;
};

const snapshot = (over: Partial<GhSnapshot['pr']> = {}, runs: GhSnapshot['checkRuns'] = []): GhSnapshot => ({
  pr: { number: 7, state: 'open', head: { sha: 'aaa' }, mergeable_state: 'clean', ...over },
  checkRuns: runs,
});
const failing = [{ id: 1, name: 'tests', status: 'completed', conclusion: 'failure' }];

async function setup(state: PrState = 'open') {
  const { SessionStore } = await import('../daemon/store.ts');
  const store = new SessionStore();
  store.ensure('s1', process.cwd());
  store.mutate('s1', (s) => {
    // Each test starts unwatched: the home, and so s1's saved state, is shared.
    delete s.prWatch;
    s.repoRoot = '/repo';
    s.plan = { ...store.publishPlan('s1', { title: 'P', tasks: [{ title: 'one' }] }).plan, branches: { 'coplan/a': { pr: { url: 'https://github.com/o/r/pull/7', number: 7, state }, updatedAt: 1 } } };
  });
  return store;
}

async function watcher(store: Awaited<ReturnType<typeof setup>>, fetch: () => Promise<{ snapshot: GhSnapshot; viewer?: string }>, opts: { now?: () => number; config?: ProjectConfig } = {}) {
  const { PrWatcher } = await import('../daemon/prWatch.ts');
  const logs: string[] = [];
  const w = new PrWatcher({ store, project: () => opts.config ?? project(), fetch, log: (m) => logs.push(m), ...(opts.now ? { now: opts.now } : {}) });
  return { w, logs };
}

test('a recorded open pull request is watched; each poll queues what is new, and a quiet poll writes nothing', async () => {
  const store = await setup();
  let now = 1_000_000;
  let snap = snapshot({}, failing);
  const { w, logs } = await watcher(store, async () => ({ snapshot: snap }), { now: () => now });
  assert.equal(w.watched().length, 1);
  await w.tick();
  const state = store.get('s1')!.prWatch!['coplan/a']!;
  assert.deepEqual(state.queue.map((q) => q.event.kind), ['ci_failed']);
  assert.deepEqual(logs, ['pull request #7 (coplan/a): ci_failed']);

  const updated = store.get('s1')!.updatedAt;
  now += 10_000;
  await w.tick();
  assert.equal(store.get('s1')!.prWatch!['coplan/a']!.checkedAt, 1_000_000, 'not due yet: inside the interval');
  now += 60_000;
  await w.tick();
  assert.equal(store.get('s1')!.prWatch!['coplan/a']!.checkedAt, now, 'due, polled');
  assert.equal(store.get('s1')!.updatedAt, updated, 'nothing new: not saved, not broadcast');

  snap = snapshot({ state: 'closed', merged: true }, failing);
  now += 60_000;
  await w.tick();
  assert.deepEqual(store.get('s1')!.prWatch!['coplan/a']!.queue.map((q) => q.event.kind), ['ci_failed', 'merged']);
  assert.equal(w.watched().length, 0, 'a poll that finds it merged stops the watch before the plan records it');
});

test('watching stops when the plan records it merged, and never starts where it is off', async () => {
  const merged = await setup('merged');
  assert.equal((await watcher(merged, async () => ({ snapshot: snapshot() }))).w.watched().length, 0);
  const open = await setup('draft');
  assert.equal((await watcher(open, async () => ({ snapshot: snapshot() }), { config: project({ tool: 'none' }) })).w.watched().length, 0);
  assert.equal((await watcher(open, async () => ({ snapshot: snapshot() }), { config: project({ watch: { ...DEFAULT_PR_WATCH, enabled: false } }) })).w.watched().length, 0);
  assert.equal((await watcher(open, async () => ({ snapshot: snapshot() }))).w.watched().length, 1, 'a draft is watched');
});

test('a restarted daemon picks up from the saved cursor: the same poll is nothing new', async () => {
  const store = await setup();
  const { w } = await watcher(store, async () => ({ snapshot: snapshot({}, failing) }));
  await w.tick();
  store.persistNow('s1');
  const { SessionStore } = await import('../daemon/store.ts');
  const again = new SessionStore();
  const { w: w2 } = await watcher(again, async () => ({ snapshot: snapshot({}, failing) }), { now: () => Date.now() + 120_000 });
  await w2.tick();
  assert.deepEqual(again.get('s1')!.prWatch!['coplan/a']!.queue.map((q) => q.event.id), ['ci:aaa:failed'], 'not queued twice');
});

test('a failing poll is said once and backs off; the next good one clears it', async () => {
  const { pollInterval } = await import('../daemon/prWatch.ts');
  const store = await setup();
  let now = 5_000_000;
  let fail = true;
  const { w, logs } = await watcher(
    store,
    async () => {
      if (fail) throw new Error('gh is not installed');
      return { snapshot: snapshot() };
    },
    { now: () => now },
  );
  await w.tick();
  now += 120_000;
  await w.tick();
  const state = store.get('s1')!.prWatch!['coplan/a']!;
  assert.equal(state.failures, 2);
  assert.equal(logs.length, 1, 'the same failure is said once');
  assert.equal(pollInterval(state, DEFAULT_PR_WATCH, now), 240, 'doubling');
  assert.equal(pollInterval({ ...state, failures: 9 }, DEFAULT_PR_WATCH, now), 1800, 'up to half an hour');
  fail = false;
  now += 240_000;
  await w.tick();
  const ok = store.get('s1')!.prWatch!['coplan/a']!;
  assert.equal(ok.error, undefined);
  assert.equal(ok.failures, undefined);
});

test('after a day with nothing new, polls slow to every five minutes', async () => {
  const { pollInterval, QUIET_MS } = await import('../daemon/prWatch.ts');
  const state = { pr: 7, since: 0, queue: [] };
  assert.equal(pollInterval(state, DEFAULT_PR_WATCH, QUIET_MS - 1), 60);
  assert.equal(pollInterval(state, DEFAULT_PR_WATCH, QUIET_MS), 300);
  assert.equal(pollInterval({ ...state, lastEventAt: QUIET_MS }, DEFAULT_PR_WATCH, QUIET_MS + 1), 60, 'an event wakes it up again');
});

test('a watched pull request keeps the daemon up', async () => {
  const { isIdle } = await import('../daemon/idle.ts');
  const none = { startedAt: 0, clients: 0, sessions: () => [] };
  assert.equal(isIdle(10 * 60_000, none, 60_000), true);
  assert.equal(isIdle(10 * 60_000, { ...none, watching: () => 1 }, 60_000), false);
});
