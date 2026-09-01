import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { ingestHook, type IngestContext } from '../daemon/hookIngest.ts';
import type { SessionStore } from '../daemon/store.ts';
import type { TranscriptTailer } from '../daemon/transcript.ts';
import type { HookOutput } from '../shared/hooks.ts';

/**
 * Stopping at a gate.
 *
 * An open gate ends the turn. The harness used to hold it open — blocking the
 * `Stop` hook, then re-blocking when the window expired — which left the CLI
 * unable to stop for the better part of an hour and spent a turn per rollover.
 * These cover the new contract and, more importantly, the deliveries that must
 * not be lost now that nothing waits: anything the user said before the turn
 * ended rides that turn, and anything they say after rides their next message.
 */

let home: string;
let cwd: string;
let store: SessionStore;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-park-home-'));
  cwd = mkdtempSync(path.join(tmpdir(), 'cc-harness-park-cwd-'));
  process.env['CC_HARNESS_HOME'] = home;
  const { SessionStore: Store } = await import('../daemon/store.ts');
  store = new Store();
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** `stopHoldSeconds` is deliberately long: nothing on the gate path may wait
 *  on it, and a test that hangs for it has caught the regression. */
const ctxWith = (over: Partial<typeof DEFAULT_CONFIG> = {}): IngestContext => ({
  store,
  config: { ...DEFAULT_CONFIG, stopHoldSeconds: 30, ...over },
  uiUrl: (id) => `http://127.0.0.1/s/${id}`,
  tailers: new Map<string, TranscriptTailer>(),
});

const stop = (id: string, ctx: IngestContext, stopHookActive = false): Promise<HookOutput> =>
  ingestHook('Stop', { session_id: id, cwd, stop_hook_active: stopHookActive }, ctx) as Promise<HookOutput>;

test('an open gate ends the turn instead of holding it', async () => {
  const id = 'park-ends-turn';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const started = Date.now();
  const out = await stop(id, ctx);
  const elapsed = Date.now() - started;

  assert.notEqual(out.decision, 'block', 'Claude is allowed to stop');
  assert.ok(elapsed < 1000, `the hook returned in ${elapsed}ms rather than holding the turn open`);
  assert.equal(store.get(id)?.status, 'waiting', 'the session reads as waiting on the user, not working');
  assert.equal(store.getGate(id, gate.id)?.status, 'open', 'and the gate is still there to be answered');
});

test('the gate is not marked as holding a turn that has ended', async () => {
  // `gate.waiting` drives the UI's "the terminal is frozen until you answer"
  // banner. Nothing is frozen any more, so claiming it would be a lie.
  const id = 'park-not-waiting';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'code_review', 'Review the diff')!;

  await stop(id, ctx);
  assert.equal(store.getGate(id, gate.id)?.waiting, false);
});

test('a verdict given before the turn ended is handed over on that turn', async () => {
  const id = 'park-answered-early';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;
  // The user answered while Claude was still finishing up. No waiter is left
  // to receive it, so the Stop hook has to deliver it or it is lost.
  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'Ship it.' });

  const out = await stop(id, ctx);
  assert.equal(out.decision, 'block', 'the turn is resumed to carry the verdict');
  assert.match(out.reason ?? '', /approved at the plan gate/);
  assert.match(out.reason ?? '', /Ship it\./);
  assert.equal(store.get(id)?.status, 'active');
});

test('a message queued before the turn ended rides that turn, and does not read as a verdict', async () => {
  const id = 'park-message';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'code_review', 'Review the diff')!;
  store.queueFeedback(id, { text: 'Actually, check the null case first.', origin: 'timeline' });

  const out = await stop(id, ctx);
  assert.equal(out.decision, 'block', 'the message is delivered rather than dropped');
  assert.match(out.reason ?? '', /check the null case first/);
  assert.match(out.reason ?? '', /gate is still open/, 'and is not mistaken for the verdict');
  assert.equal(store.getGate(id, gate.id)?.status, 'open', 'the gate itself is untouched');
});

test('a verdict given after the turn ended arrives with the next message', async () => {
  const id = 'park-answered-late';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'question', 'Map or plain object?')!;

  const out = await stop(id, ctx);
  assert.notEqual(out.decision, 'block', 'the turn ends with the gate unanswered');

  // This is now the ordinary path, not the fallback it used to be: the user
  // answers in the UI with the session stopped, and speaks to it next.
  store.resolveGate(id, gate.id, { verdict: 'answered', resolvedAt: Date.now(), comment: 'A Map.' });
  const resumed = await ingestHook('UserPromptSubmit', { session_id: id, cwd, prompt: 'carry on' }, ctx);
  assert.match(
    resumed.hookSpecificOutput?.additionalContext ?? '',
    /A Map\./,
    'the verdict is handed over with the message that woke the session',
  );
});

test('"send now" delivers the message, not a phantom verdict', async () => {
  const id = 'park-sendnow';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;
  // What the "send now" route does: queue the message, then close the gate.
  store.queueFeedback(id, {
    text: 'Forget the plan — fix the README typo first.',
    origin: 'timeline',
    interrupt: true,
    skippedGate: { kind: gate.kind, prompt: gate.prompt },
  });
  store.cancelGate(id, gate.id);

  const out = await stop(id, ctx);
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /fix the README typo first/);
  assert.match(out.reason ?? '', /do not wait on it/i);
  assert.doesNotMatch(
    out.reason ?? '',
    /gate is still open/,
    'the message closed the gate, so nothing may claim it is still there',
  );
});

test('a second gate supersedes the first without holding the turn for either', async () => {
  const id = 'park-superseded';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const first = store.openGate(id, 'plan', 'First plan')!;
  const second = store.openGate(id, 'plan', 'Second plan')!;

  const out = await stop(id, ctx);
  assert.notEqual(out.decision, 'block');
  assert.equal(store.getGate(id, first.id)?.status, 'cancelled');
  assert.equal(store.getGate(id, second.id)?.status, 'open', 'the live gate is the one left to answer');
  assert.equal(store.get(id)?.status, 'waiting');
});

test('a session with no gate still just stops', async () => {
  const id = 'park-no-gate';
  const ctx = ctxWith();
  store.ensure(id, cwd);

  const out = await stop(id, ctx);
  assert.notEqual(out.decision, 'block');
  assert.equal(store.get(id)?.status, 'idle', 'no gate and nothing queued means idle, not waiting');
});
