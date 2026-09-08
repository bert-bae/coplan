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
 * A stopped Claude Code session cannot be woken from outside — no socket, no
 * IPC, no CLI verb — so the only moment at which answering in the browser can
 * move the session on by itself is while the `Stop` hook that would end the
 * turn is still running. That window is what these cover, from both sides:
 * that answering inside it genuinely resumes the turn, and that it stays
 * bounded and never renews, which is what made the previous hold pathological.
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

/**
 * A hold short enough that an unanswered gate does not slow the suite down.
 * `stopHoldSeconds` stays long on purpose: nothing on the gate path may wait
 * on it, and a test that hangs for it has caught the regression.
 */
const HOLD_MS = 120;

const ctxWith = (over: Partial<typeof DEFAULT_CONFIG> = {}): IngestContext => ({
  store,
  config: { ...DEFAULT_CONFIG, stopHoldSeconds: 30, gateHoldSeconds: HOLD_MS / 1000, ...over },
  uiUrl: (id) => `http://127.0.0.1/s/${id}`,
  tailers: new Map<string, TranscriptTailer>(),
});

const stop = (id: string, ctx: IngestContext, stopHookActive = false): Promise<HookOutput> =>
  ingestHook('Stop', { session_id: id, cwd, stop_hook_active: stopHookActive }, ctx) as Promise<HookOutput>;

/**
 * Wait until the Stop hook has actually reached the gate.
 *
 * A fixed sleep here would be a race dressed up as a delay: on a loaded
 * machine the user's action can land before the hook has parked, and the test
 * would be exercising the "answered early" path while claiming to exercise
 * the hold.
 */
async function parked(id: string, gateId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (store.getGate(id, gateId)?.waiting) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the Stop hook never parked on the gate');
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/* ------------------------------------------------------------------ *
 * Answering in the UI moves the session on
 * ------------------------------------------------------------------ */

test('answering the gate while the turn is held resumes the session', async () => {
  // The whole point of the harness: the user clicks Approve in the browser
  // and Claude carries on, without them going back to the terminal to type.
  const id = 'park-answer-resumes';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const turn = stop(id, ctx);
  await parked(id, gate.id);
  assert.equal(store.get(id)?.status, 'waiting', 'the session reads as waiting while it is held');
  assert.equal(store.getGate(id, gate.id)?.waiting, true, 'and the gate says a turn is genuinely parked on it');

  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'Ship it.' });

  const out = await turn;
  assert.equal(out.decision, 'block', 'the turn is resumed rather than ended');
  assert.match(out.reason ?? '', /approved at the plan gate/);
  assert.match(out.reason ?? '', /Ship it\./);
  assert.equal(store.get(id)?.status, 'active');
  assert.ok(store.getGate(id, gate.id)?.deliveredAt, 'and the verdict is not delivered a second time later');
});

test('a message typed in the browser also resumes a held turn', async () => {
  // Without this a message queued in the UI sat unread behind a gate nobody
  // had got round to answering.
  const id = 'park-message-resumes';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'code_review', 'Review the diff')!;

  const turn = stop(id, ctx);
  await parked(id, gate.id);
  store.queueFeedback(id, { text: 'Check the null case first.', origin: 'timeline' });

  const out = await turn;
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /Check the null case first/);
  assert.match(out.reason ?? '', /gate is still open/, 'and is not mistaken for the verdict');
  assert.equal(store.getGate(id, gate.id)?.status, 'open', 'the gate itself is untouched');
});

test('"send now" resumes the held turn with the message, not a phantom verdict', async () => {
  const id = 'park-sendnow-resumes';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const turn = stop(id, ctx);
  await parked(id, gate.id);
  // What the "send now" route does: queue the message, then close the gate.
  store.queueFeedback(id, {
    text: 'Forget the plan — fix the README typo first.',
    origin: 'timeline',
    interrupt: true,
    skippedGate: { kind: gate.kind, prompt: gate.prompt },
  });
  store.cancelGate(id, gate.id);

  const out = await turn;
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /fix the README typo first/);
  assert.match(out.reason ?? '', /do not wait on it/i);
  assert.doesNotMatch(
    out.reason ?? '',
    /gate is still open/,
    'the message closed the gate, so nothing may claim it is still there',
  );
});

test('a gate cancelled with nothing behind it lets the turn end', async () => {
  // A superseded gate will never produce a verdict. Holding the rest of the
  // window for it, or blocking with nothing to say, both waste the turn.
  const id = 'park-superseded-releases';
  const ctx = ctxWith({ gateHoldSeconds: 30 });
  store.ensure(id, cwd);
  const first = store.openGate(id, 'plan', 'First plan')!;

  const turn = stop(id, ctx);
  await parked(id, first.id);
  const second = store.openGate(id, 'plan', 'Second plan')!;

  const started = Date.now();
  const out = await turn;
  assert.notEqual(out.decision, 'block', 'nothing is blocked with nothing to say');
  assert.ok(Date.now() - started < 5000, 'and the turn is released rather than serving out the window');
  assert.equal(store.getGate(id, first.id)?.status, 'cancelled');
  assert.equal(store.getGate(id, second.id)?.status, 'open', 'the live gate is the one left to answer');
  assert.equal(store.get(id)?.status, 'waiting');
});

/* ------------------------------------------------------------------ *
 * The hold stays bounded
 * ------------------------------------------------------------------ */

test('an unanswered gate lets the turn end when the window closes', async () => {
  const id = 'park-window-closes';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const out = await stop(id, ctx);

  assert.notEqual(out.decision, 'block', 'Claude is allowed to stop');
  assert.equal(store.get(id)?.status, 'waiting', 'the session reads as waiting on the user, not working');
  assert.equal(store.getGate(id, gate.id)?.status, 'open', 'and the gate is still there to be answered');
  assert.equal(
    store.getGate(id, gate.id)?.waiting,
    false,
    'nothing is parked on it any more, and the UI must not claim the terminal is frozen',
  );
});

test('the hold never renews itself', async () => {
  // The version of this that re-blocked on expiry held the CLI in-turn for
  // gateHoldRounds × stopHoldSeconds — over half an hour in which the session
  // was structurally unable to stop. Expiry must cost exactly one window.
  const id = 'park-no-renew';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  store.openGate(id, 'question', 'Map or plain object?');

  const first = Date.now();
  const one = await stop(id, ctx);
  const oneTook = Date.now() - first;

  const second = Date.now();
  const two = await stop(id, ctx, true);
  const twoTook = Date.now() - second;

  // The decision is the real guard: a rollover re-blocks on expiry, which is
  // exactly what these two assertions forbid.
  assert.notEqual(one.decision, 'block', 'an expired window must not block with nothing to say');
  assert.notEqual(two.decision, 'block');
  // And the clock backs it up: two windows back to back would be double this.
  for (const took of [oneTook, twoTook]) {
    assert.ok(took < HOLD_MS * 3, `one window, not a rollover — took ${took}ms`);
  }
});

test('gateHoldSeconds: 0 stops at the gate immediately', async () => {
  // The escape hatch for anyone who wants the terminal back the instant a
  // gate opens, at the cost of answering in the UI never resuming anything.
  const id = 'park-hold-disabled';
  const ctx = ctxWith({ gateHoldSeconds: 0 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const started = Date.now();
  const out = await stop(id, ctx);

  assert.notEqual(out.decision, 'block');
  assert.ok(Date.now() - started < HOLD_MS, 'nothing was held');
  assert.equal(store.getGate(id, gate.id)?.status, 'open');
});

/* ------------------------------------------------------------------ *
 * Nothing the user said is lost
 * ------------------------------------------------------------------ */

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

test('a verdict and a message waiting together are both delivered on one turn', async () => {
  // These used to be mutually exclusive branches: the message won, and the
  // verdict Claude was actually waiting for sat undelivered for a whole extra
  // round while it worked on the comment.
  const id = 'park-both-pending';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;
  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'Looks right.' });
  store.queueFeedback(id, { text: 'One more thing: rename the flag.', origin: 'timeline' });

  const out = await stop(id, ctx);
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /approved at the plan gate/, 'the verdict is there');
  assert.match(out.reason ?? '', /rename the flag/, 'and so is the message');
  assert.doesNotMatch(
    out.reason ?? '',
    /gate is still open/,
    'the gate it belonged to was answered, so nothing may claim it is still open',
  );
  assert.ok(store.getGate(id, gate.id)?.deliveredAt, 'and the verdict counts as delivered');
});

test('a verdict given after the turn ended arrives with the next message', async () => {
  const id = 'park-answered-late';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'question', 'Map or plain object?')!;

  const out = await stop(id, ctx);
  assert.notEqual(out.decision, 'block', 'the turn ends with the gate unanswered');

  // The window closed, so this is the fallback path, not the main one.
  store.resolveGate(id, gate.id, { verdict: 'answered', resolvedAt: Date.now(), comment: 'A Map.' });
  const resumed = await ingestHook('UserPromptSubmit', { session_id: id, cwd, prompt: 'carry on' }, ctx);
  assert.match(
    resumed.hookSpecificOutput?.additionalContext ?? '',
    /A Map\./,
    'the verdict is handed over with the message that woke the session',
  );
});

test('a session with no gate still just stops', async () => {
  const id = 'park-no-gate';
  const ctx = ctxWith();
  store.ensure(id, cwd);

  const out = await stop(id, ctx);
  assert.notEqual(out.decision, 'block');
  assert.equal(store.get(id)?.status, 'idle', 'no gate and nothing queued means idle, not waiting');
});

/* ------------------------------------------------------------------ *
 * What the session reads as afterwards
 * ------------------------------------------------------------------ */

test('a session the user has answered stops asking for their attention', async () => {
  // `waiting` is what puts a session in the rail's "Action required" group.
  // Nothing cleared it when the gate was answered, so a session the user had
  // just signed off on went on saying "needs you" — right after the UI told
  // them Claude was resuming.
  const id = 'park-status-settles';
  const ctx = ctxWith({ gateHoldSeconds: 0 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;
  await stop(id, ctx);
  assert.equal(store.get(id)?.status, 'waiting');

  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now() });

  const after = store.get(id)!;
  assert.equal(after.status, 'idle', 'the session has stopped, and no longer claims to want something');
  const summary = store.summaries().find((s) => s.sessionId === id)!;
  assert.equal(summary.openGates, 0);
  assert.equal(
    summary.openGates > 0 || summary.status === 'waiting',
    false,
    'so the rail no longer files it under "needs you"',
  );
});

test('skipping a gate also settles the session', async () => {
  const id = 'park-status-settles-cancel';
  const ctx = ctxWith({ gateHoldSeconds: 0 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'code_review', 'Review the diff')!;
  await stop(id, ctx);

  store.cancelGate(id, gate.id);
  assert.equal(store.get(id)?.status, 'idle');
});

test('a hold configured past the relay window is clamped to it', async () => {
  // The relay gives `Stop` 570s of curl. A hold longer than that is not a
  // longer wait, it is a wait whose answer is discarded: the relay is killed
  // before the daemon can hand the verdict back, and the user sat through
  // nine minutes for nothing.
  const id = 'park-hold-clamped';
  const ctx = ctxWith({ gateHoldSeconds: 86_400 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const turn = stop(id, ctx);
  await parked(id, gate.id);
  store.resolveGate(id, gate.id, { verdict: 'approved', resolvedAt: Date.now() });
  const out = await withTimeout(turn, 5000);

  assert.ok(out, 'the hold is bounded by something, not by the config alone');
  assert.equal(out.decision, 'block');
});

test('a gate skipped during the hold leaves the session idle, not still asking', async () => {
  // The hold can end because the gate was closed rather than answered. There
  // is then nothing left for the user to do, and saying "waiting" would put
  // the session back in the rail's "needs you" group over nothing.
  const id = 'park-skip-settles';
  const ctx = ctxWith({ gateHoldSeconds: 30 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const turn = stop(id, ctx);
  await parked(id, gate.id);
  store.cancelGate(id, gate.id);

  const out = await withTimeout(turn, 5000);
  assert.ok(out, 'the hold was released rather than serving out its window');
  assert.notEqual(out.decision, 'block', 'there is nothing to say, so nothing is blocked');
  assert.equal(store.get(id)?.status, 'idle');
});

test('one gate gets one hold that ends in a message, not an endless chain', async () => {
  // Chatting to a session while a gate sits open used to hold, block, hold,
  // block for as long as the user kept typing — and every block draws on the
  // CLI's consecutive-block allowance. The message still gets through; what
  // is bounded is how many turns the harness will hold open for one gate.
  const id = 'park-chain-bounded';
  const ctx = ctxWith({ gateHoldSeconds: 30 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const first = stop(id, ctx);
  await parked(id, gate.id);
  store.queueFeedback(id, { text: 'One thought.', origin: 'timeline' });
  const one = await first;
  assert.equal(one.decision, 'block', 'the first message resumes the turn');

  // Claude answers and stops again, still on the same gate. This time the
  // hold is spent, so the turn ends instead of being held for another round.
  const started = Date.now();
  const two = await stop(id, ctx, true);
  assert.notEqual(two.decision, 'block');
  assert.ok(Date.now() - started < 5000, 'it stopped rather than holding for another window');

  // Nothing is lost: what the user says next still reaches the session.
  store.queueFeedback(id, { text: 'And another.', origin: 'timeline' });
  const next = await ingestHook('UserPromptSubmit', { session_id: id, cwd, prompt: 'go on' }, ctx);
  assert.match(next.hookSpecificOutput?.additionalContext ?? '', /And another\./);
});

test('a verdict frees the next gate to be held again', async () => {
  // The chain bound is per gate. A gate that was answered is finished, so the
  // gate after it is a new question and gets its own window — otherwise only
  // the first gate of a run would ever resume from the browser.
  const id = 'park-chain-resets';
  const ctx = ctxWith({ gateHoldSeconds: 30 });
  store.ensure(id, cwd);

  const first = store.openGate(id, 'plan', 'Review the plan')!;
  const turnOne = stop(id, ctx);
  await parked(id, first.id);
  store.resolveGate(id, first.id, { verdict: 'approved', resolvedAt: Date.now() });
  assert.equal((await turnOne).decision, 'block');

  // Claude implements and publishes a diff. Still the same continuation
  // chain, so `stop_hook_active` is set — but this is a different gate.
  const second = store.openGate(id, 'code_review', 'Review the diff')!;
  const turnTwo = stop(id, ctx, true);
  await parked(id, second.id);
  store.resolveGate(id, second.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'Good.' });

  const out = await withTimeout(turnTwo, 5000);
  assert.ok(out, 'the second gate was held too');
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /Good\./);
});

test('an expired hold does not flash the session as working on its way out', async () => {
  // The hold's teardown used to promote the session to `active` — broadcast
  // over SSE — before the Stop hook set the real status a line later. Every
  // unanswered gate made the session card flicker from "waiting" to "working"
  // and back, for a turn that was in fact ending.
  const id = 'park-no-flicker';
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, 'plan', 'Review the plan')!;

  const seen: string[] = [];
  const listen = (event: { type: string; patch?: { status?: string } }) => {
    if (event.type === 'state' && event.patch?.status) seen.push(event.patch.status);
  };
  store.on('event', listen);
  try {
    await stop(id, ctx);
  } finally {
    store.off('event', listen);
  }

  assert.equal(store.getGate(id, gate.id)?.waiting, false, 'the gate is no longer marked as parked');
  assert.ok(
    !seen.includes('active'),
    `nothing claimed the session was working on a turn that was ending (saw ${seen.join(', ')})`,
  );
});

test('two verdicts waiting are both handed over, not just the older one', async () => {
  // Answering while the session is stopped and then answering again after
  // another gate has come and gone leaves two verdicts queued. Delivering
  // only the first strands the more recent one behind a stale one — which
  // reads, from the browser, as the second click having done nothing.
  const id = 'park-two-verdicts';
  const ctx = ctxWith({ gateHoldSeconds: 0 });
  store.ensure(id, cwd);

  const first = store.openGate(id, 'plan', 'Review the plan')!;
  await stop(id, ctx);
  store.resolveGate(id, first.id, { verdict: 'approved', resolvedAt: Date.now(), comment: 'First answer.' });

  const second = store.openGate(id, 'question', 'Map or object?')!;
  store.resolveGate(id, second.id, { verdict: 'answered', resolvedAt: Date.now(), comment: 'Second answer.' });

  const out = await ingestHook('UserPromptSubmit', { session_id: id, cwd, prompt: 'go on' }, ctx);
  const text = out.hookSpecificOutput?.additionalContext ?? '';
  assert.match(text, /First answer\./);
  assert.match(text, /Second answer\./, 'the newer verdict is not stranded behind the older one');
  assert.ok(store.undeliveredGates(id).length === 0, 'and nothing is left undelivered');
});
