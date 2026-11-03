import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The session store: persistence, eviction, deletion, and the plan edits it
 * commits — atomically, or not at all.
 */

let home: string;
before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-test-'));
  process.env['CC_HARNESS_HOME'] = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

async function freshStore() {
  const { SessionStore } = await import('../daemon/store.ts');
  return new SessionStore();
}

const PLAN = { title: 'Plan', tasks: [{ title: 'one' }, { title: 'two' }] };

test('a plan survives a daemon restart', async () => {
  const store = await freshStore();
  store.ensure('s1', process.cwd());
  store.publishPlan('s1', PLAN);
  store.applyOps('s1', [{ op: 'upsert_task', id: 't1', status: 'done' }], 'user');
  store.persistNow('s1');

  const reloaded = await freshStore();
  const plan = reloaded.get('s1')?.plan;
  assert.ok(plan, 'the plan was reloaded from disk');
  assert.equal(plan!.tasks.find((t) => t.id === 't1')?.status, 'done');
  assert.equal(plan!.changes.at(-1)?.author, 'user', 'and so was its change log');
});

test('a refused edit changes nothing', async () => {
  const store = await freshStore();
  store.ensure('s2', process.cwd());
  store.publishPlan('s2', PLAN);
  const before = JSON.stringify(store.get('s2')!.plan);
  assert.throws(() => store.applyOps('s2', [{ op: 'upsert_task', title: 'ok' }, { op: 'remove', kind: 'task', id: 'nope' }], 'user'));
  assert.equal(JSON.stringify(store.get('s2')!.plan), before);
});

test('the user can start a plan before Claude publishes one', async () => {
  const store = await freshStore();
  store.ensure('s3', process.cwd());
  store.applyOps('s3', [{ op: 'set_meta', title: 'My idea' }, { op: 'upsert_task', title: 'first step' }], 'user');
  const plan = store.get('s3')!.plan!;
  assert.equal(plan.title, 'My idea');
  assert.equal(plan.tasks[0]!.createdBy, 'user');
});

test('reading moves Claude to the end of the change log', async () => {
  const store = await freshStore();
  store.ensure('s4', process.cwd());
  store.publishPlan('s4', PLAN);
  store.applyOps('s4', [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'hm' }], 'user');
  const { summarize } = await import('../daemon/store.ts');
  assert.equal(summarize(store.get('s4')!).unreadByClaude, 1);
  store.markRead('s4');
  assert.equal(summarize(store.get('s4')!).unreadByClaude, 0);
});

test('every change is broadcast as a whole-session snapshot', async () => {
  const store = await freshStore();
  store.ensure('s5', process.cwd());
  const seen: string[] = [];
  store.on('event', (e: { type: string }) => seen.push(e.type));
  store.publishPlan('s5', PLAN);
  store.applyOps('s5', [{ op: 'upsert_task', title: 'more' }], 'user');
  assert.ok(seen.includes('snapshot'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.filter((t) => t === 'sessions').length, 1, 'the rail hears about it once per tick');
});

test('a session written by the old review loop is migrated to a plan', async () => {
  const dir = path.join(home, 'sessions', 'legacy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      sessionId: 'legacy',
      cwd: process.cwd(),
      title: 'old',
      status: 'waiting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: 'plan_review',
      gates: [{ id: 'g' }],
      plan: { title: 'Old plan', summary: 'why', markdown: 'notes', steps: [{ id: 's1', title: 'step one' }], revision: 1 },
    }),
  );
  const store = await freshStore();
  const s = store.get('legacy')!;
  assert.equal(s.plan?.title, 'Old plan');
  assert.deepEqual(s.plan?.tasks.map((t) => t.title), ['step one']);
  assert.equal(s.plan?.sections[0]?.body, 'notes');
  assert.equal(s.status, 'idle');
  assert.equal((s as unknown as Record<string, unknown>)['gates'], undefined, 'the review-loop state is dropped');
});

test('sweep evicts sessions that ended long ago and keeps live ones', async () => {
  const store = await freshStore();
  store.ensure('live', process.cwd());
  store.ensure('finished', process.cwd());
  store.update('finished', { status: 'ended', endedAt: Date.now() - 2 * 60 * 60 * 1000 });
  store.sweep({ endedTtlMs: 60 * 60 * 1000 });
  assert.equal(store.get('finished'), undefined);
  assert.ok(store.get('live'));
});

test('an evicted session is read back from disk, not blanked', async () => {
  const store = await freshStore();
  store.ensure('evicted', process.cwd());
  store.publishPlan('evicted', PLAN);
  store.drop('evicted');
  assert.equal(store.get('evicted'), undefined);
  assert.equal(store.ensure('evicted', process.cwd()).plan?.title, 'Plan');
});

test('purge removes a session from memory and from disk, for good', async () => {
  const store = await freshStore();
  store.ensure('gone', process.cwd());
  store.publishPlan('gone', PLAN);
  store.persistNow('gone');
  assert.equal(store.purge('gone'), true);
  assert.ok(!existsSync(path.join(home, 'sessions', 'gone')));
  assert.equal(store.ensure('gone', process.cwd()).plan, null, 'a purged session does not come back');
  assert.equal(store.purge('never-existed'), false);
});

test('sessions older than the retention window are not loaded', async () => {
  const dir = path.join(home, 'sessions', 'ancient');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ sessionId: 'ancient', cwd: process.cwd(), updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, status: 'ended' }),
  );
  const store = await freshStore();
  assert.equal(store.get('ancient'), undefined);
});

test('an unreadable state file is moved aside, never overwritten', async () => {
  const dir = path.join(home, 'sessions', 'damaged');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), '{"sessionId":"damaged","plan":{"title":"precious"'); // truncated
  const store = await freshStore();
  assert.equal(store.get('damaged'), undefined);
  const aside = readdirSync(dir).find((f) => f.startsWith('state.corrupt-'));
  assert.ok(aside, 'the damaged file is kept beside, for recovery by hand');
  assert.match(readFileSync(path.join(dir, aside!), 'utf8'), /precious/);

  // A fresh session under the same id now starts clean without touching it.
  store.ensure('damaged', process.cwd());
  store.persistNow('damaged');
  assert.ok(existsSync(path.join(dir, aside!)));
});

test('a plan missing lists from an older build still loads', async () => {
  const dir = path.join(home, 'sessions', 'sparse');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ sessionId: 'sparse', cwd: '/x', title: 't', status: 'idle', updatedAt: Date.now(), plan: { title: 'P', tasks: [], seq: 3 } }),
  );
  const store = await freshStore();
  const plan = store.get('sparse')?.plan;
  assert.ok(plan);
  assert.deepEqual(plan!.threads, []);
  assert.deepEqual(plan!.diagrams, []);
  assert.equal(plan!.seq, 3);
});
