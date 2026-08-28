import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, shutdownChildren, killAllChildren, liveChildCount } from '../daemon/proc.ts';
import { TranscriptTailer } from '../daemon/transcript.ts';
import { isPidAlive } from '../shared/paths.ts';

/**
 * Resource-cleanup regressions.
 *
 * Every case here is a way the harness previously leaked: an orphaned process
 * tree, a promise that never settled, a poller that outlived its session, or
 * state that grew for as long as the daemon ran. They are cheap to break by
 * accident and invisible until a user notices their fans spinning.
 */

let home: string;
before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-cleanup-'));
  process.env['CC_HARNESS_HOME'] = home;
});
after(() => {
  killAllChildren();
  rmSync(home, { recursive: true, force: true });
});

/** Wait for a predicate, so tests do not race a signal's delivery. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

/* ------------------------------------------------------------------ *
 * Process trees
 * ------------------------------------------------------------------ */

test('a cancelled command kills the whole process tree, not just the shell', async () => {
  const pidFile = path.join(home, 'grandchild.pid');
  // `sh -c` forks the sleep; killing only the shell would leave it running.
  const handle = run(`sh -c 'sleep 120 & echo $! > ${pidFile}; wait'`, {
    cwd: home,
    timeoutMs: 60_000,
    label: 'tree test',
  });

  await until(() => {
    try {
      return readPid(pidFile) > 0;
    } catch {
      return false;
    }
  });
  const grandchild = readPid(pidFile);
  assert.ok(grandchild > 0, 'the grandchild should have recorded its pid');
  assert.equal(isPidAlive(grandchild), true, 'the grandchild should be running');

  handle.cancel();
  const outcome = await handle.result;

  assert.equal(outcome.cancelled, true);
  assert.equal(
    await until(() => !isPidAlive(grandchild)),
    true,
    'the grandchild must not survive the cancellation',
  );
});

test('a timeout kills the tree and always settles', async () => {
  const handle = run(`sleep 60`, { cwd: home, timeoutMs: 300, label: 'timeout test' });
  const outcome = await handle.result;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.ok, false);
});

test('a command whose child holds stdout open still settles', async () => {
  // The classic hang: the shell exits but a background process inherits the
  // pipes, so `close` never fires. Settling must not depend on it.
  const handle = run(`sh -c '(sleep 30 &) ; echo done'`, {
    cwd: home,
    timeoutMs: 10_000,
    label: 'orphan pipe test',
  });
  const outcome = await Promise.race([handle.result, sleep(6_000).then(() => null)]);
  assert.notEqual(outcome, null, 'the promise must settle without waiting on the orphan');
  assert.match(outcome!.output, /done/);
});

test('the orphan holding the pipes is reaped, not merely stepped around', async () => {
  // Settling without waiting on the orphan is only half the job: the whole
  // point of the module is that nothing it starts outlives it. `cancel()` is
  // a no-op once settled, so if settling does not reap the group the process
  // survives — which is how this test used to leak a 30-second sleep.
  const pidFile = path.join(home, 'orphan.pid');
  const handle = run(`sh -c '(sleep 30 & echo $! > ${pidFile}) ; echo done'`, {
    cwd: home,
    timeoutMs: 10_000,
    label: 'orphan reap test',
  });

  const outcome = await Promise.race([handle.result, sleep(6_000).then(() => null)]);
  assert.notEqual(outcome, null, 'the promise must settle');

  const orphan = readPid(pidFile);
  assert.ok(orphan > 0, 'the background process should have recorded its pid');
  assert.equal(
    await until(() => !isPidAlive(orphan)),
    true,
    'the background process must not survive the command that started it',
  );
  assert.equal(liveChildCount(), 0, 'and the registry must not still be holding it');
});

test('a child started during shutdown is still reaped', async () => {
  // `shutdownChildren` used to signal a snapshot and then clear the registry.
  // Anything spawned inside the grace window — a sequential runner advancing
  // to its next command — was neither signalled nor left visible to the
  // exit-time sweep, so it outlived the daemon.
  //
  // The first child ignores SIGTERM so the grace period actually elapses;
  // otherwise it dies at once, the wait loop exits, and the latecomer arrives
  // after the sweep rather than during it.
  // The first child has to survive SIGTERM, or the wait loop ends before the
  // latecomer is spawned and the race under test never happens. A shell with
  // `trap "" TERM` is not enough — the group signal kills the `sleep` it is
  // blocked on and the shell falls through — so use a process that genuinely
  // installs a handler and stays up. `exec` matters: without it the shell is
  // the group leader, and the shell has no handler — it dies to the SIGTERM,
  // the wait loop ends, and the latecomer is spawned after the sweep instead
  // of during it.
  const first = run(`exec node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, {
    cwd: home,
    timeoutMs: 60_000,
    label: 'shutdown stubborn',
  });
  // Let the handler be installed before anything signals it.
  await sleep(400);

  const shutdown = shutdownChildren(1_500);

  await sleep(200);
  const late = run('sleep 30', { cwd: home, timeoutMs: 60_000, label: 'shutdown latecomer' });
  const latePid = late.pid;

  try {
    await shutdown;
    assert.ok(latePid && latePid > 0, 'the latecomer should have a pid to check');
    assert.equal(
      await until(() => !isPidAlive(latePid!)),
      true,
      'a child spawned during the grace window must still be killed',
    );
  } finally {
    // Leave the registry empty even if an assertion failed, or the next test
    // inherits this one's children and fails for the wrong reason.
    killAllChildren();
    await Promise.all([first.result, late.result]);
  }
});

test('output is capped rather than accumulated without limit', async () => {
  const handle = run(`sh -c 'i=0; while [ $i -lt 400 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done'`, {
    cwd: home,
    timeoutMs: 20_000,
    maxOutput: 500,
    label: 'output cap test',
  });
  const outcome = await handle.result;
  assert.ok(outcome.output.length <= 600, `output should stay bounded, got ${outcome.output.length}`);
});

test('shutdownChildren reaps everything still running', async () => {
  const a = run('sleep 60', { cwd: home, timeoutMs: 60_000, label: 'a' });
  const b = run('sleep 60', { cwd: home, timeoutMs: 60_000, label: 'b' });
  assert.equal(liveChildCount(), 2);

  const reaped = await shutdownChildren(300);
  assert.equal(reaped, 2);
  assert.equal(liveChildCount(), 0);

  // Both promises must still settle; nothing is left awaiting a dead process.
  await Promise.all([a.result, b.result]);
});

test('a successful command reports its exit code and is deregistered', async () => {
  const before = liveChildCount();
  const ok = await run('exit 0', { cwd: home, timeoutMs: 10_000 }).result;
  const bad = await run('exit 3', { cwd: home, timeoutMs: 10_000 }).result;
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.equal(liveChildCount(), before, 'finished children must not stay registered');
});

/* ------------------------------------------------------------------ *
 * Tailers
 * ------------------------------------------------------------------ */

test('closing a tailer stops its poller and is idempotent', async () => {
  const file = path.join(home, 'tail.jsonl');
  writeFileSync(file, '');
  let updates = 0;
  const tailer = new TranscriptTailer(file, () => updates++);
  tailer.start(true);

  writeFileSync(file, `${JSON.stringify({ type: 'ai-title', title: 'hello' })}\n`);
  await until(() => updates > 0);
  assert.ok(updates > 0, 'the tailer should have read the file');

  tailer.close();
  tailer.close(); // must not throw

  const seen = updates;
  writeFileSync(file, `${JSON.stringify({ type: 'ai-title', title: 'later' })}\n`);
  await sleep(1_200);
  assert.equal(updates, seen, 'a closed tailer must not keep reading');
});

/* ------------------------------------------------------------------ *
 * Store retention
 * ------------------------------------------------------------------ */

async function freshStore() {
  const { SessionStore } = await import('../daemon/store.ts');
  return new SessionStore();
}

test('gate history is capped', async () => {
  const store = await freshStore();
  store.ensure('gates', process.cwd());
  for (let i = 0; i < 120; i++) {
    const gate = store.openGate('gates', 'question', `q${i}`)!;
    store.resolveGate('gates', gate.id, { verdict: 'answered', resolvedAt: Date.now() });
    store.markGateDelivered('gates', gate.id);
  }
  const session = store.get('gates')!;
  assert.ok(session.gates.length <= 41, `expected a capped gate list, got ${session.gates.length}`);
});

test('an open gate is never trimmed away', async () => {
  const store = await freshStore();
  store.ensure('keep', process.cwd());
  for (let i = 0; i < 80; i++) {
    const gate = store.openGate('keep', 'question', `q${i}`)!;
    store.resolveGate('keep', gate.id, { verdict: 'answered', resolvedAt: Date.now() });
    store.markGateDelivered('keep', gate.id);
  }
  const open = store.openGate('keep', 'plan', 'still open')!;
  assert.equal(store.activeGate('keep')!.id, open.id);
  assert.ok(store.getGate('keep', open.id), 'the open gate must survive trimming');
});

test('sweep evicts sessions that ended long ago and keeps live ones', async () => {
  const store = await freshStore();
  store.ensure('live', process.cwd());
  store.ensure('finished', process.cwd());
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  store.update('finished', { status: 'ended', endedAt: twoHoursAgo });

  const dropped = store.sweep({ endedTtlMs: 60 * 60 * 1000 });
  assert.ok(dropped >= 1);
  assert.equal(store.get('finished'), undefined, 'a long-finished session should be evicted');
  assert.ok(store.get('live'), 'an active session must be kept');
});

test('dropping a session releases its cached diff', async () => {
  const store = await freshStore();
  store.ensure('withdiff', process.cwd());
  store.setDiff('withdiff', {
    baseRef: 'abc',
    files: [],
    additions: 0,
    deletions: 0,
    generatedAt: Date.now(),
  } as never);
  assert.ok(store.getDiff('withdiff'));
  store.drop('withdiff');
  assert.equal(store.get('withdiff'), undefined);
});

test('an evicted session is rehydrated, not silently blanked', async () => {
  // `sweep` evicts from memory but leaves state.json on disk. If the next
  // hook for that id created a fresh session, its first persist would write
  // straight over the top — so a `--resume` an hour later would find the
  // whole recorded history gone.
  const store = await freshStore();
  store.ensure('evicted', process.cwd());
  store.setStage('evicted', 'code_review', 'most of the way through');
  store.addTimeline('evicted', 'note', 'something worth keeping');
  store.mutate('evicted', (state) => {
    state.status = 'ended';
    state.endedAt = Date.now() - 2 * 60 * 60 * 1000;
    state.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
  });
  store.persistNow('evicted');

  // Other tests share this home, so assert on this session rather than a count.
  store.sweep({ endedTtlMs: 60 * 60 * 1000 });
  assert.equal(store.get('evicted'), undefined, 'the cold session is gone from memory');

  const revived = store.ensure('evicted', process.cwd());
  assert.equal(revived.stage, 'code_review', 'the stage came back');
  assert.ok(
    revived.timeline.some((e) => e.text === 'something worth keeping'),
    'and so did the history',
  );
});

test('a session that never existed is created fresh rather than failing', async () => {
  const store = await freshStore();
  const made = store.ensure('brand-new', process.cwd());
  assert.equal(made.stage, 'idle');
  assert.equal(made.timeline.length, 0);
});

test('reading a cached diff refreshes its place in the LRU', async () => {
  // Eviction was insertion-ordered, so the diff being actively reviewed —
  // the one read on every render — was the likeliest to be thrown out.
  const store = await freshStore();
  const diff = (ref: string) =>
    ({ baseRef: ref, files: [], additions: 0, deletions: 0, generatedAt: Date.now() }) as never;

  const { MAX_CACHED_DIFFS } = await import('../daemon/store.ts');
  const ids: string[] = [];
  for (let i = 0; i < MAX_CACHED_DIFFS; i++) {
    const id = `s${i}`;
    ids.push(id);
    store.ensure(id, process.cwd());
    store.setDiff(id, diff(id));
  }

  // `getDiff` falls back to the persisted copy, which would mask eviction
  // entirely. Remove the files so memory is the only source of truth.
  for (const id of ids) rmSync(path.join(home, 'sessions', id, 'diff.json'), { force: true });

  // Touch the oldest, so recency and insertion order disagree.
  const oldest = ids[0]!;
  assert.ok(store.getDiff(oldest), 'the oldest entry is still cached');

  store.ensure('newcomer', process.cwd());
  store.setDiff('newcomer', diff('newcomer'));
  rmSync(path.join(home, 'sessions', 'newcomer', 'diff.json'), { force: true });

  assert.ok(store.getDiff(oldest), 'the entry just read survives the eviction');
  assert.equal(store.getDiff(ids[1]!), undefined, 'the genuinely least-recent one is evicted');
});

test('sessions older than the retention window are not loaded from disk', async () => {
  const stale = path.join(home, 'sessions', 'ancient');
  mkdirSync(stale, { recursive: true });
  writeFileSync(
    path.join(stale, 'state.json'),
    JSON.stringify({
      sessionId: 'ancient',
      cwd: process.cwd(),
      updatedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
      gates: [],
      status: 'ended',
    }),
  );
  const store = await freshStore();
  assert.equal(store.get('ancient'), undefined, 'a two-month-old session should not be resident');
});

/* ------------------------------------------------------------------ *
 * Baselines
 * ------------------------------------------------------------------ */

test('pruneBaselines drops entries for sessions that are gone', async () => {
  const { reconcileFiles, pruneBaselines, baselineCount } = await import('../daemon/tasks.ts');
  const store = await freshStore();
  store.ensure('b1', process.cwd());
  store.ensure('b2', process.cwd());
  await reconcileFiles(store, 'b1');
  await reconcileFiles(store, 'b2');
  assert.equal(baselineCount(), 2);

  const removed = pruneBaselines((id) => id === 'b1');
  assert.equal(removed, 1);
  assert.equal(baselineCount(), 1);
});

function readPid(file: string): number {
  return Number(readFileSync(file, 'utf8').trim());
}
