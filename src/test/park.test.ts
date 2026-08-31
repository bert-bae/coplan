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
 * Waiting at a gate.
 *
 * The model is not supposed to poll: it publishes, ends its turn, and the
 * `Stop` hook parks in the daemon until the UI says something. These cover the
 * three ways that park ends — answered, interrupted by a message, and expired
 * — because each one is a way for the user's input to get lost if it is wrong.
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

/** A hold short enough to expire inside a test, and only one rollover. */
const ctxWith = (over: Partial<typeof DEFAULT_CONFIG> = {}): IngestContext => ({
  store,
  config: { ...DEFAULT_CONFIG, stopHoldSeconds: 0.15, gateHoldRounds: 1, ...over },
  uiUrl: (id) => `http://127.0.0.1/s/${id}`,
  tailers: new Map<string, TranscriptTailer>(),
});

const stop = (id: string, ctx: IngestContext, stopHookActive = false): Promise<HookOutput> =>
  ingestHook('Stop', { session_id: id, cwd, stop_hook_active: stopHookActive }, ctx) as Promise<HookOutput>;

test('the parked turn resumes on the verdict, without the model having polled', async () => {
  const id = 'park-resolve';
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const parked = stop(id, ctx);
  // The user answers in the UI while the hook is holding.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.get(id)?.status, 'waiting', 'the session shows as waiting while parked');
  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'Ship it.' });

  const out = await parked;
  assert.equal(out.decision, 'block', 'the turn is resumed rather than ended');
  assert.match(out.reason ?? '', /approved at the plan gate/);
  assert.match(out.reason ?? '', /Ship it\./);
  assert.equal(store.get(id)?.status, 'active');
});

test('a message sent while a gate is open reaches the session instead of queueing behind it', async () => {
  const id = 'park-message';
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'code_review', 'Review the diff')!;

  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  store.queueFeedback(id, { text: 'Actually, check the null case first.', origin: 'timeline' });

  const out = await parked;
  assert.equal(out.decision, 'block', 'the message wakes the parked turn');
  assert.match(out.reason ?? '', /check the null case first/);
  assert.match(out.reason ?? '', /gate is still open/, 'and is not mistaken for the verdict');
  assert.equal(store.getGate(id, gate.id)?.status, 'open', 'the gate itself is untouched');
});

test('an expired hold re-parks quietly rather than asking the model to poll', async () => {
  const id = 'park-expire';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  store.openGate(id, 'plan', 'Review the plan');

  const out = await stop(id, ctx);
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /Still parked at the "plan" gate/);
  assert.match(out.reason ?? '', /end your turn again/i);
  assert.doesNotMatch(out.reason ?? '', /harness_await/, 'the model is never sent back to poll');
});

test('the harness stops holding the terminal once its patience runs out', async () => {
  const id = 'park-giveup';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'question', 'Map or plain object?')!;

  await stop(id, ctx); // round 1: re-parks
  const out = await stop(id, ctx, true); // round 2: over the limit
  assert.notEqual(out.decision, 'block', 'the turn is allowed to end');
  assert.equal(store.get(id)?.status, 'idle');
  assert.match(
    store.get(id)?.timeline.at(-1)?.text ?? '',
    /Stopped holding the turn/,
    'and the UI says why, so the gate does not look ignored',
  );

  // Answering afterwards is not lost: it rides along with the next prompt.
  store.resolveGate(id, gate.id, { verdict: 'answered', resolvedAt: Date.now(), comment: 'A Map.' });
  const resumed = await ingestHook(
    'UserPromptSubmit',
    { session_id: id, cwd, prompt: 'carry on' },
    ctx,
  );
  assert.match(
    resumed.hookSpecificOutput?.additionalContext ?? '',
    /A Map\./,
    'the verdict is handed over with the message that woke the session',
  );
});

test('a superseded gate releases the park instead of holding for nothing', async () => {
  const id = 'park-superseded';
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  store.openGate(id, 'plan', 'First plan');

  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  // Publishing again cancels the first gate; nothing will ever resolve it.
  store.openGate(id, 'plan', 'Second plan');

  const out = await parked;
  assert.notEqual(out.decision, 'block', 'the hook returns rather than holding its full window');
});
