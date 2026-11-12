import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, renameSync, utimesSync } from 'node:fs';
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

test('no two session ids share a folder, however their names are made safe', async () => {
  const { sanitizeId } = await import('../shared/paths.ts');
  const long = 'x'.repeat(128);
  // Lone surrogates too, which UTF-8 would turn into one and the same character.
  const ids = ['a/b', 'a_b', 'a:b', `${long}1`, `${long}2`, '..', '__', '', 'unknown', 's\ud800', 's\udbff'];
  const names = ids.map(sanitizeId);
  assert.equal(new Set(names).size, ids.length, JSON.stringify(names));
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9._-]{1,128}$/);
    assert.ok(!/^\.+$/.test(name), name);
    assert.equal(sanitizeId(name), name, 'a folder name names itself');
  }
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(sanitizeId(uuid), uuid, 'an id already safe is its own folder name, as it always was');
});

test('sessions whose ids are made safe alike keep their own plans', async () => {
  const store = await freshStore();
  store.ensure('team/x', process.cwd());
  store.publishPlan('team/x', { title: 'Slash', tasks: [{ title: 'one' }] });
  store.persistNow('team/x');
  assert.equal(store.ensure('team_x', process.cwd()).plan, null, "not the other one's plan");
  store.publishPlan('team_x', { title: 'Underscore', tasks: [{ title: 'one' }] });
  store.persistNow('team_x');
  const reloaded = await freshStore();
  assert.equal(reloaded.get('team/x')?.plan?.title, 'Slash');
  assert.equal(reloaded.get('team_x')?.plan?.title, 'Underscore');
});

test('a session kept in a folder named the old way is saved to its own', async () => {
  const { paths } = await import('../shared/paths.ts');
  const store = await freshStore();
  store.ensure('old:style', process.cwd());
  store.publishPlan('old:style', PLAN);
  store.persistNow('old:style');
  store.drop('old:style');
  // As an earlier build kept it: the id made safe, and nothing more.
  const old = path.join(home, 'sessions', 'old_style');
  if (paths.sessionDir('old:style') !== old) renameSync(paths.sessionDir('old:style'), old);
  // Its own folder there already, with nothing saved in it: still read from the old one.
  mkdirSync(paths.sessionDir('old:style'));
  const reloaded = await freshStore();
  assert.equal(reloaded.get('old:style')?.plan?.title, PLAN.title);
  assert.ok(existsSync(paths.sessionState('old:style')), 'saved to its own');
  assert.ok(existsSync(path.join(old, 'state.json')), 'the old one left as it was');

  // Once both are there, the one in the session's own folder is the one saved since.
  const stale = JSON.parse(readFileSync(paths.sessionState('old:style'), 'utf8')) as { plan: { title: string }; updatedAt: number };
  stale.plan.title = 'Stale';
  stale.updatedAt -= 1000;
  writeFileSync(path.join(old, 'state.json'), JSON.stringify(stale));
  for (let i = 0; i < 3; i++) assert.equal((await freshStore()).get('old:style')?.plan?.title, PLAN.title);
  assert.ok(existsSync(old), 'the other left for housekeeping');
});

test("a session's own folder wins over its old one once it holds a copy, however the old one is dated; past keeping, it gives way", async () => {
  const { paths } = await import('../shared/paths.ts');
  const ownTitle = (id: string) => JSON.parse(readFileSync(paths.sessionState(id), 'utf8')).plan.title;
  // An earlier build, run again, stamps its stale copy newer (a hook): the work in the own folder stays.
  for (const [id, old, how, age, wins] of [
    ['run:again', 'run_again', 'load', 60_000, 'In its own folder'],
    ['later:again', 'later_again', 'ensure', 60_000, 'In its own folder'],
    ['long:gone', 'long_gone', 'load', 120 * 24 * 60 * 60 * 1000, 'From the earlier build'],
  ] as const) {
    const store = await freshStore();
    store.ensure(id, process.cwd());
    store.publishPlan(id, { title: 'In its own folder', tasks: [{ title: 'one' }] });
    store.persistNow(id);
    store.drop(id);
    const up = how === 'ensure' ? await freshStore() : undefined;
    up?.drop(id);
    const own = JSON.parse(readFileSync(paths.sessionState(id), 'utf8')) as { plan: { title: string }; updatedAt: number };
    writeFileSync(paths.sessionState(id), JSON.stringify({ ...own, updatedAt: Date.now() - age }));
    mkdirSync(path.join(home, 'sessions', old), { recursive: true });
    writeFileSync(path.join(home, 'sessions', old, 'state.json'), JSON.stringify({ ...own, plan: { ...own.plan, title: 'From the earlier build' }, updatedAt: Date.now() + 600_000 }));
    const next = up ?? (await freshStore());
    const title = how === 'load' ? next.get(id)?.plan?.title : next.ensure(id, process.cwd()).plan?.title;
    assert.equal(title, wins, id);
    assert.equal(ownTitle(id), wins, `${id}: its own folder holds it`);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'sessions', old, 'state.json'), 'utf8')).plan.title, 'From the earlier build', `${id}: the old one left as it was`);
  }
  // Taken from its old folder, a change since that moves no time (its folder learnt) survives the next start.
  const kept = await freshStore();
  kept.ensure('tie:break', '');
  kept.publishPlan('tie:break', PLAN);
  kept.persistNow('tie:break');
  kept.drop('tie:break');
  renameSync(paths.sessionDir('tie:break'), path.join(home, 'sessions', 'tie_break'));
  const first = await freshStore();
  first.ensure('tie:break', '/home/me/proj');
  first.persistAll();
  assert.equal((await freshStore()).get('tie:break')?.cwd, '/home/me/proj');
});

test("an old folder's copy is not taken over another session's; an unreadable own copy gives way to it", async () => {
  const { paths, sanitizeId, legacyName } = await import('../shared/paths.ts');
  const template = async (id: string, title: string) => {
    const store = await freshStore();
    store.ensure(id, process.cwd());
    store.publishPlan(id, { title, tasks: [{ title: 'one' }] });
    store.persistNow(id);
    store.drop(id);
    return JSON.parse(readFileSync(paths.sessionState(id), 'utf8')) as Record<string, unknown> & { updatedAt: number };
  };
  const put = (folder: string, state: object) => {
    mkdirSync(path.join(home, 'sessions', folder), { recursive: true });
    writeFileSync(path.join(home, 'sessions', folder, 'state.json'), JSON.stringify(state));
  };

  // x:y's own folder holds y's copy, kept the old way there: x:y's newer old copy does not go over it.
  const x = 'x:y';
  const y = sanitizeId(x).replace('_', ':');
  assert.equal(legacyName(y), sanitizeId(x));
  const xs = await template(x, 'Plan of x');
  rmSync(paths.sessionDir(x), { recursive: true, force: true });
  put(sanitizeId(x), { ...(await template(y, 'Plan of y')), updatedAt: Date.now() - 1_000 });
  rmSync(paths.sessionDir(y), { recursive: true, force: true });
  put(legacyName(x), { ...xs, updatedAt: Date.now() });
  const booted = await freshStore();
  assert.equal(booted.get(y)?.plan?.title, 'Plan of y', 'y kept its plan');
  assert.equal(JSON.parse(readFileSync(path.join(home, 'sessions', sanitizeId(x), 'state.json'), 'utf8')).sessionId, y, "x's copy did not go over it");

  // Its own copy unreadable (moved aside), the old one is taken by ensure, as at load.
  const up = await freshStore();
  const kept = await template('torn:up', 'Kept the old way');
  put(legacyName('torn:up'), { ...kept, updatedAt: Date.now() });
  writeFileSync(paths.sessionState('torn:up'), '{"sessionId":"torn:up","plan":{"tit');
  assert.equal(up.ensure('torn:up', process.cwd()).plan?.title, 'Kept the old way');
});

test('a session kept the old way is found by ensure as at load, and deleted for good, folder and all', async () => {
  const { paths } = await import('../shared/paths.ts');
  const old = path.join(home, 'sessions', 'later_x');
  // Kept the old way, and not loaded at start (past the cap, or written after it).
  const store = await freshStore();
  const seeded = await freshStore();
  seeded.ensure('later:x', process.cwd());
  seeded.publishPlan('later:x', PLAN);
  seeded.drop('later:x');
  renameSync(paths.sessionDir('later:x'), old);
  assert.equal(store.ensure('later:x', process.cwd()).plan?.title, PLAN.title, 'its plan, not a blank one');
  assert.ok(existsSync(paths.sessionState('later:x')), 'and saved to its own folder');
  // Deleted: neither folder brings it back.
  store.purge('later:x');
  assert.equal(existsSync(old), false);
  assert.equal((await freshStore()).get('later:x'), undefined, 'gone after a restart too');
});

test("a session whose id is another's old folder name is not served that one's plan, nor saves over it", async () => {
  const { paths } = await import('../shared/paths.ts');
  // `odd:one`, kept the old way in `odd_one`, not loaded at start; then a session whose id is `odd_one`.
  const store = await freshStore();
  const seeded = await freshStore();
  seeded.ensure('odd:one', process.cwd());
  seeded.publishPlan('odd:one', PLAN);
  seeded.drop('odd:one');
  renameSync(paths.sessionDir('odd:one'), path.join(home, 'sessions', 'odd_one'));
  assert.equal(store.ensure('odd_one', process.cwd()).plan, null, 'its own, blank');
  assert.ok(existsSync(paths.sessionState('odd:one')), "the other's copied to its own folder first");
  store.publishPlan('odd_one', { title: 'Mine', tasks: [{ title: 'one' }] });
  store.persistNow('odd_one');
  const reloaded = await freshStore();
  assert.equal(reloaded.get('odd:one')?.plan?.title, PLAN.title, 'the other kept its plan');
  assert.equal(reloaded.get('odd_one')?.plan?.title, 'Mine');
});

/* A session whose old folder name is another session's own folder (`p:q`
 * would have been kept in `p_q`, where session `p_q` keeps its plan):
 * neither loses its plan to the other. */

test("a session is neither served nor deleted with the plan of another whose folder has its old name", async () => {
  const { paths } = await import('../shared/paths.ts');
  const store = await freshStore();
  store.ensure('p_q', process.cwd());
  store.publishPlan('p_q', { title: 'Theirs', tasks: [{ title: 'one' }] });
  store.persistNow('p_q');
  assert.equal(store.ensure('p:q', process.cwd()).plan, null, 'its own, blank');
  store.publishPlan('p:q', PLAN);
  store.persistNow('p:q');
  store.purge('p:q');
  assert.equal(existsSync(paths.sessionDir('p:q')), false, 'deleted itself');
  assert.ok(existsSync(paths.sessionState('p_q')), "but not the other's folder");
  const reloaded = await freshStore();
  assert.equal(reloaded.get('p:q'), undefined);
  assert.equal(reloaded.get('p_q')?.plan?.title, 'Theirs', 'which keeps its plan');
});

test("a session's old copy, found in another's folder, does not go over its newer own", async () => {
  const { paths } = await import('../shared/paths.ts');
  // `c:d` kept the old way in `c_d`; moved to its own folder and changed since, the old copy left behind.
  const seeded = await freshStore();
  seeded.ensure('c:d', process.cwd());
  seeded.publishPlan('c:d', { title: 'Old', tasks: [{ title: 'one' }] });
  seeded.persistNow('c:d');
  seeded.drop('c:d');
  renameSync(paths.sessionDir('c:d'), path.join(home, 'sessions', 'c_d'));
  const store = await freshStore();
  store.ensure('c:d', process.cwd());
  store.publishPlan('c:d', { title: 'Newer', tasks: [{ title: 'one' }] });
  store.persistNow('c:d');
  store.drop('c:d');
  // Then session `c_d` starts, finding the old copy in what is its own folder.
  store.ensure('c_d', process.cwd());
  assert.equal(JSON.parse(readFileSync(paths.sessionState('c:d'), 'utf8')).plan.title, 'Newer');
  assert.equal((await freshStore()).get('c:d')?.plan?.title, 'Newer', 'after a restart too');
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

test('a saved session with no time of its own is dated by its file: one untouched for months expires at a start', async () => {
  const { paths, legacyName } = await import('../shared/paths.ts');
  const months = (Date.now() - 120 * 24 * 60 * 60 * 1000) / 1000;
  const undated = (id: string) => ({ sessionId: id, cwd: process.cwd(), title: 'early build', status: 'idle', plan: null });
  // In its own folder, and in a folder an earlier build named.
  mkdirSync(paths.sessionDir('undated-own'), { recursive: true });
  writeFileSync(paths.sessionState('undated-own'), JSON.stringify(undated('undated-own')));
  utimesSync(paths.sessionState('undated-own'), months, months);
  const old = path.join(home, 'sessions', legacyName('undated:old'));
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, 'state.json'), JSON.stringify(undated('undated:old')));
  utimesSync(path.join(old, 'state.json'), months, months);
  // One saved recently is kept, dated by its file too.
  mkdirSync(paths.sessionDir('undated-recent'), { recursive: true });
  writeFileSync(paths.sessionState('undated-recent'), JSON.stringify(undated('undated-recent')));
  const store = await freshStore();
  assert.equal(store.get('undated-own')?.sessionId, undefined, 'past keeping, not loaded');
  assert.equal(store.get('undated:old')?.sessionId, undefined, 'nor its old-folder copy');
  assert.notEqual(store.ensure('undated:old', process.cwd()).title, 'early build', 'nor brought back by ensure');
  // While the store runs, a session a hook asks for is live: one past keeping is read back, from an earlier
  // build's folder or its own (dropped from memory, say), not saved over with a blank one.
  const late = path.join(home, 'sessions', legacyName('undated:late'));
  mkdirSync(late, { recursive: true });
  writeFileSync(path.join(late, 'state.json'), JSON.stringify(undated('undated:late')));
  utimesSync(path.join(late, 'state.json'), months, months);
  assert.equal(store.ensure('undated:late', process.cwd()).title, 'early build', 'read back from its old folder');
  mkdirSync(paths.sessionDir('undated-late-own'), { recursive: true });
  writeFileSync(paths.sessionState('undated-late-own'), JSON.stringify(undated('undated-late-own')));
  utimesSync(paths.sessionState('undated-late-own'), months, months);
  assert.equal(store.ensure('undated-late-own', process.cwd()).title, 'early build', 'read back from its own folder');
  // Dated now and saved, so the next start keeps it.
  const next = await freshStore();
  assert.equal(next.get('undated:late')?.title, 'early build', 'kept at the next start (old folder)');
  assert.equal(next.get('undated-late-own')?.title, 'early build', 'kept at the next start (own folder)');
  assert.ok(Math.abs((store.get('undated-recent')?.updatedAt ?? 0) - Date.now()) < 60_000, 'a recent one is kept');
});

test('an undated session loaded is saved with the date its file gave it, so a later copy of the file keeps its age', async () => {
  const { paths } = await import('../shared/paths.ts');
  const days20 = Date.now() - 20 * 24 * 60 * 60 * 1000;
  mkdirSync(paths.sessionDir('undated-saved'), { recursive: true });
  writeFileSync(paths.sessionState('undated-saved'), JSON.stringify({ sessionId: 'undated-saved', cwd: process.cwd(), title: 'early build', status: 'idle', plan: null }));
  utimesSync(paths.sessionState('undated-saved'), days20 / 1000, days20 / 1000);
  await freshStore();
  const onDisk = JSON.parse(readFileSync(paths.sessionState('undated-saved'), 'utf8')) as { updatedAt?: number };
  assert.ok(Math.abs((onDisk.updatedAt ?? 0) - days20) < 60_000, `dated on disk by its file: ${onDisk.updatedAt}`);
});

test('an undated session past the cap on sessions held in memory is saved with its date too', async () => {
  const { paths } = await import('../shared/paths.ts');
  const days25 = Date.now() - 25 * 24 * 60 * 60 * 1000;
  // More sessions with a plan than are held, all newer: the undated one stays cold, on disk.
  const plan = { title: 'p', summary: '', sections: [], diagrams: [], tasks: [], threads: [] };
  for (let i = 0; i < 61; i++) {
    mkdirSync(paths.sessionDir(`held-${i}`), { recursive: true });
    writeFileSync(paths.sessionState(`held-${i}`), JSON.stringify({ sessionId: `held-${i}`, cwd: process.cwd(), title: 'x', status: 'idle', plan, updatedAt: Date.now() - i * 1000 }));
  }
  mkdirSync(paths.sessionDir('cold-undated'), { recursive: true });
  writeFileSync(paths.sessionState('cold-undated'), JSON.stringify({ sessionId: 'cold-undated', cwd: process.cwd(), title: 'early build', status: 'idle', plan }));
  utimesSync(paths.sessionState('cold-undated'), days25 / 1000, days25 / 1000);
  try {
    const store = await freshStore();
    assert.equal(store.get('cold-undated'), undefined, 'past the cap, not in memory');
    const onDisk = JSON.parse(readFileSync(paths.sessionState('cold-undated'), 'utf8')) as { updatedAt?: number };
    assert.ok(Math.abs((onDisk.updatedAt ?? 0) - days25) < 60_000, `dated on disk by its file: ${onDisk.updatedAt}`);
  } finally {
    for (let i = 0; i < 61; i++) rmSync(paths.sessionDir(`held-${i}`), { recursive: true, force: true });
    rmSync(paths.sessionDir('cold-undated'), { recursive: true, force: true });
  }
});

test('a save that fails while the store starts, before anyone listens, is told to the first listener', async () => {
  const { paths } = await import('../shared/paths.ts');
  mkdirSync(paths.sessionDir('unsaved-at-start'), { recursive: true });
  writeFileSync(paths.sessionState('unsaved-at-start'), JSON.stringify({ sessionId: 'unsaved-at-start', cwd: process.cwd(), title: 'early build', status: 'idle', plan: null }));
  // Its temp file's name taken by a folder: every save of it fails (EISDIR), the one at start too.
  const blocker = path.join(paths.sessionDir('unsaved-at-start'), `.state.${process.pid}.tmp`);
  mkdirSync(blocker);
  try {
    const store = await freshStore();
    const told: string[] = [];
    // A listener of another name first: the held one waits for an 'event' listener.
    store.on('other', () => {});
    store.on('event', (e: { type: string; sessionId?: string; message?: string }) => {
      if (e.type === 'persist-error') told.push(`${e.sessionId}:${e.message}`);
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(told, ['unsaved-at-start:EISDIR'], 'the save at start, told once someone listens');
    // Said once per kind of failure, as any.
    store.publishPlan('unsaved-at-start', PLAN);
    store.drop('unsaved-at-start');
    assert.deepEqual(told, ['unsaved-at-start:EISDIR']);
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
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

test("a copy in a session's old folder is not loaded over its own folder's file from a newer build", async () => {
  const { paths, legacyName } = await import('../shared/paths.ts');
  const id = 'down:grade';
  // As this build saved it once, then moved to the folder an earlier build named.
  const store = await freshStore();
  store.ensure(id, process.cwd());
  store.publishPlan(id, { title: 'From the earlier build', tasks: [{ title: 'one' }] });
  store.persistNow(id);
  store.drop(id);
  const old = path.join(home, 'sessions', legacyName(id));
  mkdirSync(old, { recursive: true });
  // As an earlier build kept it: no format of its own named.
  const { schemaVersion: _none, ...earlier } = JSON.parse(readFileSync(paths.sessionState(id), 'utf8')) as Record<string, unknown>;
  const oldCopy = JSON.stringify({ ...earlier, updatedAt: Date.now() });
  writeFileSync(path.join(old, 'state.json'), oldCopy);
  // Since then, a newer Coplan has saved the session in its own folder.
  const future = JSON.stringify({ schemaVersion: 99, sessionId: id, title: 'x', plan: { shape: 'new' } });
  writeFileSync(paths.sessionState(id), future);
  // Downgraded: the old copy is not loaded, nor saved over the newer one.
  const booted = await freshStore();
  assert.equal(booted.get(id)?.plan?.title, undefined, 'not loaded from the old folder');
  // Nor when its hook arrives: started afresh in memory, never saved there.
  const hooked = booted.ensure(id, process.cwd());
  assert.equal(hooked.plan?.title, undefined, 'not taken from the old folder by ensure');
  assert.equal(hooked.savedByNewer, true);
  booted.persistNow(id);
  booted.persistAll();
  assert.equal(readFileSync(paths.sessionState(id), 'utf8'), future, "the newer build's file is left as it is");
  assert.equal(readFileSync(path.join(old, 'state.json'), 'utf8'), oldCopy, 'and the old copy, for the earlier build');
});

test('a newer Coplan\'s session is not saved over under an id its folder name changes', async () => {
  // Session ids become folder names with anything unsafe made safe: `a/b` is kept in `a_b-<hash>`.
  const { paths } = await import('../shared/paths.ts');
  const dir = paths.sessionDir('from/the/future');
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
  const later = paths.sessionDir('also/from/the/future');
  mkdirSync(later, { recursive: true });
  const laterFile = path.join(later, 'state.json');
  writeFileSync(laterFile, future);
  store.ensure('also/from/the/future', process.cwd());
  store.publishPlan('also/from/the/future', PLAN);
  store.persistNow('also/from/the/future');
  assert.equal(readFileSync(laterFile, 'utf8'), future);
});

test("a newer Coplan's session is marked for the page to say so, and deleting it frees its id", async () => {
  const id = 'newer-then-deleted';
  const dir = path.join(home, 'sessions', id);
  const file = path.join(dir, 'state.json');
  const future = JSON.stringify({ schemaVersion: 99, sessionId: id, plan: { shape: 'new' } });
  const writeFuture = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, future);
  };
  writeFuture();
  const store = await freshStore();
  assert.equal(store.ensure(id, process.cwd()).savedByNewer, true);
  const { summarize } = await import('../daemon/store.ts');
  assert.equal(summarize(store.get(id)!).savedByNewer, true, 'and the session list says so too');
  assert.equal(summarize(store.get(id)!).engaged, true, 'listing it, blank as it is here');
  store.publishPlan(id, PLAN);
  assert.equal(store.get(id)?.savedByNewer, true, 'through edits');
  store.persistNow(id);
  assert.equal(readFileSync(file, 'utf8'), future, 'and never saved over');

  // Deleted on purpose: gone, and the id is this build's again.
  assert.equal(store.purge(id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(store.ensure(id, process.cwd()).savedByNewer, undefined);
  assert.equal(summarize(store.get(id)!).savedByNewer, undefined);
  store.publishPlan(id, PLAN);
  store.persistNow(id);
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: number }).schemaVersion, 1);

  // A mark found on disk is not this build's to keep: it would stop the saves.
  const kept = store.get(id);
  store.drop(id);
  writeFileSync(file, JSON.stringify({ ...kept, schemaVersion: 1, savedByNewer: true }));
  assert.equal(store.ensure(id, process.cwd()).savedByNewer, undefined);

  // A folder the delete could not remove is the newer build's still, on disk.
  store.purge(id);
  writeFuture();
  assert.equal(store.ensure(id, process.cwd()).savedByNewer, true);
  store.persistNow(id);
  assert.equal(readFileSync(file, 'utf8'), future);
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

test('a session kept the old way and past the cap stays cold at load: not copied to its own folder', async () => {
  const own = mkdtempSync(path.join(tmpdir(), 'cc-harness-cap-'));
  process.env['CC_HARNESS_HOME'] = own;
  try {
    const { paths, legacyName } = await import('../shared/paths.ts');
    const store = await freshStore();
    // Sixty-one plain sessions, each kept in the folder an earlier build named.
    for (let i = 0; i < 61; i++) {
      const id = `cold:${i}`;
      store.ensure(id, process.cwd());
      store.get(id)!.updatedAt = Date.now() - 60_000 + i;
      store.persistNow(id);
      store.drop(id);
      renameSync(paths.sessionDir(id), path.join(own, 'sessions', legacyName(id)));
    }
    const booted = await freshStore();
    assert.equal(booted.get('cold:0')?.sessionId, undefined, 'the oldest is past the cap');
    assert.equal(existsSync(paths.sessionState('cold:0')), false, 'and is not saved to its own folder');
    assert.ok(existsSync(path.join(own, 'sessions', legacyName('cold:0'), 'state.json')), 'its old copy is where it was');
    assert.ok(existsSync(paths.sessionState('cold:1')), 'one within it is');
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

test("a newer Coplan's session is not pushed out of memory by newer plain sessions", async () => {
  const own = mkdtempSync(path.join(tmpdir(), 'cc-harness-cap-'));
  process.env['CC_HARNESS_HOME'] = own;
  try {
    const { paths } = await import('../shared/paths.ts');
    mkdirSync(paths.sessionDir('from-newer'), { recursive: true });
    writeFileSync(paths.sessionState('from-newer'), JSON.stringify({ schemaVersion: 99, sessionId: 'from-newer' }));
    const store = await freshStore();
    store.ensure('from-newer', process.cwd());
    store.get('from-newer')!.updatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) store.ensure(`plain-${i}`, process.cwd());
    store.sweep({ endedTtlMs: 60 * 60 * 1000 });
    assert.equal(store.get('from-newer')?.savedByNewer, true, 'still listed, and still saying why it is blank');
  } finally {
    process.env['CC_HARNESS_HOME'] = home;
    rmSync(own, { recursive: true, force: true });
  }
});

test('save failures held for the first listener come in order, and are not stranded by removeAllListeners', async () => {
  const store = await freshStore();
  const fail = (id: string) => store.emitEvent({ type: 'persist-error', sessionId: id, message: 'EIO' });
  fail('a');
  fail('b');
  // Every listener removed (and with them the one waiting for the first): still held.
  store.removeAllListeners();
  const told: string[] = [];
  store.on('event', (e: { type: string; sessionId?: string }) => {
    if (e.type === 'persist-error') told.push(e.sessionId!);
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(told, ['a', 'b'], 'told once a listener is on');
  // Held again (no listener), then one raised live before they are told comes after them.
  store.removeAllListeners();
  fail('c');
  store.on('event', (e: { type: string; sessionId?: string }) => {
    if (e.type === 'persist-error') told.push(e.sessionId!);
  });
  fail('live');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(told, ['a', 'b', 'c', 'live']);
});

test('save failures still held when the only listener goes part way through are told to the next one', async () => {
  const store = await freshStore();
  const fail = (id: string) => store.emitEvent({ type: 'persist-error', sessionId: id, message: 'EIO' });
  fail('a');
  fail('b');
  fail('c');
  const first: string[] = [];
  store.once('event', (e: { sessionId?: string }) => first.push(e.sessionId!));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(first, ['a'], 'a once() listener takes one');
  const next: string[] = [];
  store.on('event', (e: { type: string; sessionId?: string }) => {
    if (e.type === 'persist-error') next.push(e.sessionId!);
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(next, ['b', 'c'], 'the rest go to the next listener');
});

test("a failed copy of another session's state, found in a folder it was named into, is said once, as any failed save", async () => {
  const { paths } = await import('../shared/paths.ts');
  const store = await freshStore();
  // Then `q_r`'s own folder is found holding `q:r`'s state (an earlier build named it so); copying it to
  // `q:r`'s folder fails.
  mkdirSync(paths.sessionDir('q_r'), { recursive: true });
  writeFileSync(paths.sessionState('q_r'), JSON.stringify({ sessionId: 'q:r', cwd: process.cwd(), title: 'theirs', status: 'idle', plan: null, updatedAt: Date.now() }));
  const blocker = path.join(paths.sessionDir('q:r'), `.state.${process.pid}.tmp`);
  mkdirSync(blocker, { recursive: true });
  try {
    const told: string[] = [];
    store.on('event', (e: { type: string; sessionId?: string; message?: string }) => {
      if (e.type === 'persist-error') told.push(`${e.sessionId}:${e.message}`);
    });
    store.ensure('q_r', process.cwd());
    store.drop('q_r');
    store.ensure('q_r', process.cwd());
    assert.deepEqual(told, ['q:r:EISDIR'], 'once, not on every read');
    assert.equal(store.saveFailure('q:r'), 'EISDIR', 'and a page opening on it is told');
    // Copied once it can be: no longer said to be failing.
    rmSync(blocker, { recursive: true, force: true });
    store.drop('q_r');
    store.ensure('q_r', process.cwd());
    assert.equal(existsSync(paths.sessionState('q:r')), true);
    assert.equal(store.saveFailure('q:r'), undefined);
  } finally {
    rmSync(blocker, { recursive: true, force: true });
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

test("every edit falls back to the project's review mode the daemon gives the store", async () => {
  const store = await freshStore();
  store.ensure('rv', process.cwd());
  store.publishPlan('rv', PLAN);
  store.reviewFor = () => 'skip';
  const plan = store.applyOps('rv', [{ op: 'upsert_task', id: 't1', status: 'done' }], 'user').plan;
  Object.assign(plan.tasks.find((t) => t.id === 't1')!, { round: 1 });
  // Closed done under a project that skips review counts as passed: taken up again, it is reopened.
  const again = store.applyOps('rv', [{ op: 'upsert_task', id: 't1', status: 'in_progress' }], 'user').plan;
  assert.equal(again.tasks.find((t) => t.id === 't1')!.reopened, true);
});

test("the session list counts a task held for the user's review by the project's review mode (#162)", async () => {
  const store = await freshStore();
  const { confirmDesign, markDelivered, submitPlan } = await import('../shared/plan.ts');
  store.ensure('rl', process.cwd());
  store.publishPlan('rl', PLAN);
  // A Managed build submitted on the repository's defaults: no settings of its own.
  store.mutate('rl', (s) => {
    s.plan = markDelivered(submitPlan(confirmDesign(s.plan!, { prompt: 'd' }), { target: 'session', mode: 'managed', prompt: 'p' }));
  });
  store.applyOps('rl', [{ op: 'upsert_task', id: 't1', stage: 'review' }], 'claude', { tracking: true });
  const row = () => store.summaries().find((s) => s.sessionId === 'rl')!;
  assert.equal(row().awaitingReview, 0, 'the default: self-review');
  store.reviewFor = () => 'user';
  assert.equal(row().awaitingReview, 1);
  assert.equal(row().planStatus, 'review');
});

test("the session list reads the project's review mode only where it counts, and once a repository (#165)", async () => {
  const store = await freshStore();
  const { confirmDesign, markDelivered, submitPlan } = await import('../shared/plan.ts');
  const submitted = (mode: 'managed' | 'tracked', settings?: { review: 'self'; parallel: number; maxRounds: number }) => (s: { plan: import('../shared/types.ts').Plan | null }) => {
    s.plan = markDelivered(submitPlan(confirmDesign(s.plan!, { prompt: 'd' }), { target: 'session', mode, prompt: 'p', ...(settings ? { settings } : {}) }));
  };
  const dir = process.cwd();
  for (const [id, how] of [
    ['m1', submitted('managed')],
    ['m2', submitted('managed')],
    ['own', submitted('managed', { review: 'self', parallel: 1, maxRounds: 3 })],
    ['tracked', submitted('tracked')],
  ] as const) {
    store.ensure(id, dir);
    store.publishPlan(id, PLAN);
    store.mutate(id, how);
  }
  store.ensure('unpublished', dir);
  const asked: string[] = [];
  store.reviewFor = (s) => {
    asked.push(s.sessionId);
    return 'user';
  };
  store.summaries();
  // Only builds on the repository's defaults that hold work for review (Managed): the two in one repository, once.
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.ok(['m1', 'm2'].includes(asked[0]!));
});
