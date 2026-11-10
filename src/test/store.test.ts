import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
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

test("a session id is always a folder in sessions/: '.' and '..' never name sessions/ or the home", async () => {
  const { paths } = await import('../shared/paths.ts');
  for (const id of ['.', '..', '...', '', '../x', '/', 'a/../..']) {
    const dir = paths.sessionDir(id);
    assert.equal(path.dirname(dir), paths.sessionsDir(), JSON.stringify(id));
    assert.ok(!['.', '..'].includes(path.basename(dir)), JSON.stringify(id));
  }
  // And so purging one deletes nothing else.
  const store = await freshStore();
  store.ensure('kept', process.cwd());
  store.persistNow('kept');
  writeFileSync(path.join(home, 'canary'), 'x');
  for (const id of ['..', '.']) store.purge(id);
  assert.ok(existsSync(path.join(home, 'canary')), 'the home is still there');
  assert.ok(existsSync(path.join(home, 'sessions', 'kept')), 'and so are the other sessions');
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

test('whether a session\'s hooks ran is kept; one saved before it was recorded is taken to have run them (#52)', async () => {
  const dir = path.join(home, 'sessions', 'before-hooked');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionId: 'before-hooked', cwd: '/x', title: 't', status: 'idle', createdAt: 5, updatedAt: Date.now(), plan: null }));
  const store = await freshStore();
  store.ensure('tools-only', process.cwd(), 'codex');
  store.persistNow('tools-only');
  const { summarize } = await import('../daemon/store.ts');
  const reloaded = await freshStore();
  assert.equal(reloaded.get('before-hooked')?.hookedAt, 5);
  assert.equal(summarize(reloaded.get('before-hooked')!).hooked, true);
  assert.equal(reloaded.get('tools-only')?.hookedAt, null, 'still none after a restart');
  assert.equal(summarize(reloaded.get('tools-only')!).hooked, false);
});

test('a session saved by a newer Coplan is never read wrongly or saved over', async () => {
  const dir = path.join(home, 'sessions', 'from-the-future');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const future = JSON.stringify({ schemaVersion: 99, sessionId: 'from-the-future', title: 'x', plan: { shape: 'new' } });
  writeFileSync(file, future);
  const store = await freshStore();
  assert.equal(store.get('from-the-future'), undefined, 'not loaded');
  // A hook for that session still works, from memory, and saving leaves the file alone.
  store.ensure('from-the-future', process.cwd());
  store.publishPlan('from-the-future', PLAN);
  store.persistNow('from-the-future');
  assert.equal(readFileSync(file, 'utf8'), future);

  // What this build saves says which format it is.
  store.ensure('today', process.cwd());
  store.persistNow('today');
  assert.equal((JSON.parse(readFileSync(path.join(home, 'sessions', 'today', 'state.json'), 'utf8')) as { schemaVersion?: number }).schemaVersion, 1);
});

test('a newer Coplan\'s session is not saved over under an id its folder name changes', async () => {
  // Session ids become folder names with anything unsafe made safe: `a/b` is kept in `a_b`.
  const dir = path.join(home, 'sessions', 'from_the_future');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const future = JSON.stringify({ schemaVersion: 99, sessionId: 'from/the/future', title: 'x', plan: { shape: 'new' } });
  writeFileSync(file, future);
  const store = await freshStore();
  store.ensure('from/the/future', process.cwd());
  store.publishPlan('from/the/future', PLAN);
  store.persistNow('from/the/future');
  store.persistAll();
  assert.equal(readFileSync(file, 'utf8'), future);

  // And one that appears after the store started, found when its first hook arrives.
  const later = path.join(home, 'sessions', 'also_from_the_future');
  mkdirSync(later, { recursive: true });
  const laterFile = path.join(later, 'state.json');
  writeFileSync(laterFile, future);
  store.ensure('also/from/the/future', process.cwd());
  store.publishPlan('also/from/the/future', PLAN);
  store.persistNow('also/from/the/future');
  assert.equal(readFileSync(laterFile, 'utf8'), future);
});

test('a prompt that never reached the agent is taken back and handed over again, unless the plan moved since', async () => {
  const store = await freshStore();
  store.ensure('handover', process.cwd());
  store.publishPlan('handover', PLAN);
  store.submit('handover', { target: 'session' });
  const prior = store.get('handover')!.plan!;
  const sent = store.deliver('handover');
  assert.ok(sent, 'the build prompt is handed over');
  assert.equal(store.pending('handover'), null, 'and recorded as sent');

  // The hook's answer never reached the agent: taken back, so the next hook
  // hands it over again — even after a daemon restart.
  const delivered = store.get('handover')!.plan!.version;
  assert.equal(store.undeliver('handover', prior, delivered), true);
  assert.ok(store.get('handover')!.plan!.version > delivered, 'as a new version, so open tabs see it');
  const reloaded = await freshStore();
  assert.deepEqual(reloaded.pending('handover'), sent);
  const beforeAgain = reloaded.get('handover')!.plan!;
  assert.deepEqual(reloaded.deliver('handover'), sent, 'the same prompt, handed over again');
  assert.equal(reloaded.deliver('handover'), null, 'and only once');
  assert.equal((await freshStore()).pending('handover'), null, 'which a restart remembers');

  // The user changed the plan after the hand-over: taking it back would undo
  // their change, so it is refused and the plan is left alone.
  const again = reloaded.get('handover')!.plan!;
  reloaded.applyOps('handover', [{ op: 'set_checks', id: 't1', add: [{ name: 'lint', run: 'pnpm lint' }] }], 'user');
  const edited = JSON.stringify(reloaded.get('handover')!.plan);
  assert.equal(reloaded.undeliver('handover', beforeAgain, again.version), false);
  assert.equal(JSON.stringify(reloaded.get('handover')!.plan), edited);
  assert.equal(reloaded.pending('handover'), null);
});

test('the ask for a task list is taken back the same way', async () => {
  const store = await freshStore();
  store.ensure('design-handover', process.cwd());
  store.publishPlan('design-handover', PLAN);
  store.confirmDesign('design-handover', {});
  const prior = store.get('design-handover')!.plan!;
  const sent = store.deliver('design-handover');
  assert.ok(sent, 'the design ask is handed over');
  assert.equal(store.pending('design-handover'), null);
  assert.equal(store.undeliver('design-handover', prior, store.get('design-handover')!.plan!.version), true);
  assert.deepEqual(store.pending('design-handover'), sent);
});

test('sessions planned in and plain ones are kept apart: neither many plain sessions nor many old plans push the other out', async () => {
  // A home of its own: what earlier tests left on disk does not count here.
  const own = mkdtempSync(path.join(tmpdir(), 'cc-harness-cap-'));
  process.env['CC_HARNESS_HOME'] = own;
  try {
    const store = await freshStore();
    const daysAgo = (n: number) => Date.now() - n * 24 * 60 * 60 * 1000;
    const at = (id: string, updatedAt: number) => {
      store.get(id)!.updatedAt = updatedAt;
      store.persistNow(id);
    };
    // A plan untouched for two days, and a session that used Coplan with no plan yet.
    store.ensure('planned', process.cwd());
    store.publishPlan('planned', PLAN);
    at('planned', daysAgo(2));
    store.ensure('engaged', process.cwd());
    store.engage('engaged');
    at('engaged', daysAgo(2));
    // Sixty newer sessions that never used Coplan (every `claude -p`, every plain chat), and one more.
    for (let i = 0; i < 61; i++) {
      store.ensure(`plain-${i}`, process.cwd());
      at(`plain-${i}`, daysAgo(1) + i);
    }
    // Sixty more plans, newer still: a pile of them must not push out a session running now.
    for (let i = 0; i < 60; i++) {
      store.ensure(`plan-${i}`, process.cwd());
      store.publishPlan(`plan-${i}`, PLAN);
      at(`plan-${i}`, daysAgo(1) + 100 + i);
    }
    store.ensure('running-now', process.cwd());
    store.persistNow('running-now');
    store.sweep({ endedTtlMs: 60 * 60 * 1000 });
    const kept = new Set(store.all().map((s) => s.sessionId));
    assert.ok(kept.has('running-now'), 'a plain session running now stays');
    assert.equal(kept.has('plain-0') || kept.has('plain-1'), false, 'the two oldest plain ones go (62 in a pool of 60)');
    assert.equal(kept.has('planned') || kept.has('engaged'), false, 'and the two oldest plans, past their own cap');
    assert.ok(kept.has('plan-0') && kept.has('plain-2'));
    assert.equal(kept.size, 120);
    // The daemon's next start keeps the same ones.
    const reloaded = await freshStore();
    assert.deepEqual(new Set(reloaded.all().map((s) => s.sessionId)), kept);
  } finally {
    process.env['CC_HARNESS_HOME'] = home;
    rmSync(own, { recursive: true, force: true });
  }
});

test('a plan is not pushed out of memory by any number of newer plain sessions', async () => {
  const own = mkdtempSync(path.join(tmpdir(), 'cc-harness-cap-'));
  process.env['CC_HARNESS_HOME'] = own;
  try {
    const store = await freshStore();
    store.ensure('planned', process.cwd());
    store.publishPlan('planned', PLAN);
    store.get('planned')!.updatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    store.persistNow('planned');
    for (let i = 0; i < 100; i++) store.ensure(`plain-${i}`, process.cwd());
    store.sweep({ endedTtlMs: 60 * 60 * 1000 });
    assert.ok(store.get('planned'));
    for (let i = 0; i < 100; i++) store.persistNow(`plain-${i}`);
    assert.ok((await freshStore()).all().some((s) => s.sessionId === 'planned'), 'nor on the next start');
  } finally {
    process.env['CC_HARNESS_HOME'] = home;
    rmSync(own, { recursive: true, force: true });
  }
});

test('a save that fails is said — once — instead of being dropped', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const store = await freshStore();
  store.ensure('readonly', process.cwd());
  store.persistNow('readonly');
  const dir = path.join(home, 'sessions', 'readonly');
  const events: unknown[] = [];
  store.on('event', (e: { type: string }) => e.type === 'persist-error' && events.push(e));
  chmodSync(dir, 0o500);
  try {
    store.publishPlan('readonly', PLAN);
    store.persistNow('readonly');
    store.persistNow('readonly');
    assert.equal(events.length, 1, 'once per kind of failure, not per save');
    assert.match(JSON.stringify(events[0]), /"sessionId":"readonly"/);
  } finally {
    chmodSync(dir, 0o700);
  }
  // Once it works again it is quiet, and a later failure is said again.
  store.persistNow('readonly');
  assert.ok(existsSync(path.join(dir, 'state.json')));
});
