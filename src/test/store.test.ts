import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

test('gates: only one is open at a time', async () => {
  const store = await freshStore();
  store.ensure('s1', process.cwd());
  const first = store.openGate('s1', 'plan', 'Review the plan')!;
  const second = store.openGate('s1', 'code_review', 'Review the code')!;

  assert.equal(store.getGate('s1', first.id)!.status, 'cancelled');
  assert.equal(store.activeGate('s1')!.id, second.id);
});

test('gates: resolving delivers the result and clears the active gate', async () => {
  const store = await freshStore();
  store.ensure('s2', process.cwd());
  const gate = store.openGate('s2', 'plan', 'Review the plan')!;

  const seen: string[] = [];
  store.on('gate:resolved', (payload: { gate: { id: string } }) => seen.push(payload.gate.id));

  store.resolveGate('s2', gate.id, { verdict: 'approved', resolvedAt: Date.now() });

  assert.deepEqual(seen, [gate.id]);
  assert.equal(store.get('s2')!.activeGateId, null);
  assert.equal(store.getGate('s2', gate.id)!.status, 'resolved');
  assert.equal(store.resolveGate('s2', gate.id, { verdict: 'approved', resolvedAt: 1 }), undefined);
});

test('feedback: drains exactly once', async () => {
  const store = await freshStore();
  store.ensure('s3', process.cwd());
  store.queueFeedback('s3', { text: 'first', origin: 'timeline' });
  store.queueFeedback('s3', { text: 'second', origin: 'diff' });

  const drained = store.drainFeedback('s3');
  assert.deepEqual(drained.map((f) => f.text), ['first', 'second']);
  assert.deepEqual(store.drainFeedback('s3'), []);
  assert.equal(store.get('s3')!.pendingFeedback.length, 0);
});

test('resolving a plan gate with edited steps updates the stored plan', async () => {
  const store = await freshStore();
  store.ensure('s4', process.cwd());
  store.mutate('s4', (s) => {
    s.plan = { title: 'p', steps: [{ id: 'a', title: 'one' }], revision: 1, updatedAt: 0 };
  });
  const gate = store.openGate('s4', 'plan', 'Review')!;
  store.resolveGate('s4', gate.id, {
    verdict: 'approved',
    resolvedAt: Date.now(),
    steps: [{ id: 'a', title: 'one, revised' }],
  });

  const plan = store.get('s4')!.plan!;
  assert.equal(plan.steps[0]!.title, 'one, revised');
  assert.equal(plan.revision, 2);
});

test('timeline is capped so a long session cannot grow without bound', async () => {
  const { SessionStore } = await import('../daemon/store.ts');
  const store = new SessionStore({ maxTimelineEvents: 10 });
  store.ensure('s5', process.cwd());
  for (let i = 0; i < 25; i++) store.addTimeline('s5', 'note', `event ${i}`);

  const timeline = store.get('s5')!.timeline;
  assert.equal(timeline.length, 10);
  assert.equal(timeline[0]!.text, 'event 15');
});

test('state survives a daemon restart', async () => {
  const store = await freshStore();
  store.ensure('s6', process.cwd());
  store.setStage('s6', 'implementing', 'building');
  store.openGate('s6', 'code_review', 'Review the code');
  store.persistNow('s6');

  const reloaded = await freshStore();
  const session = reloaded.get('s6');
  assert.ok(session, 'session was reloaded from disk');
  assert.equal(session!.stage, 'implementing');
  assert.equal(session!.gates.length, 1);
  assert.equal(session!.gates[0]!.waiting, false, 'a parked waiter does not survive a restart');
});

test('purge removes a session from memory and from disk', async () => {
  const store = await freshStore();
  store.ensure('s7', process.cwd());
  store.setStage('s7', 'implementing', 'building');
  store.persistNow('s7');
  assert.ok(existsSync(path.join(home, 'sessions', 's7', 'state.json')));

  assert.equal(store.purge('s7'), true);
  assert.equal(store.get('s7'), undefined);
  assert.ok(!existsSync(path.join(home, 'sessions', 's7')), 'the directory goes too');

  // `ensure` reads state back off disk for swept sessions. Purge has to beat
  // that, or the next hook mentioning this id would resurrect it.
  const revived = store.ensure('s7', process.cwd());
  assert.equal(revived.stage, 'idle', 'a purged session does not come back');
});

test('a purged session does not reappear after a restart', async () => {
  const store = await freshStore();
  store.ensure('s8', process.cwd());
  store.persistNow('s8');
  store.purge('s8');

  const reloaded = await freshStore();
  assert.equal(reloaded.get('s8'), undefined);
});

test('purge reports whether there was anything to delete', async () => {
  const store = await freshStore();
  assert.equal(store.purge('never-existed'), false);
});

test('drop is eviction, not deletion: the state stays on disk', async () => {
  const store = await freshStore();
  store.ensure('s9', process.cwd());
  store.setStage('s9', 'planning', 'thinking');
  store.drop('s9');

  assert.equal(store.get('s9'), undefined, 'evicted from memory');
  const reloaded = await freshStore();
  assert.equal(reloaded.get('s9')?.stage, 'planning', 'but still recoverable');
});
