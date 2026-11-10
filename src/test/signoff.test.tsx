import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { Plan, SessionState } from '../shared/types.ts';
import type { AgentKind } from '../shared/agents.ts';

/**
 * The page's six sign-off actions: submit, reopen, confirm the design,
 * reopen it, queue a revision request, withdraw it. Each sends one request
 * for the session on screen, puts the daemon's answer in place unless
 * something newer already landed, says what happened, and resolves true;
 * a refusal is shown in the daemon's words and resolves false, changing
 * nothing. An answer for a session the user has since left never lands on
 * the one on screen. Pinned here before the six are folded into one helper,
 * and `commit` made to share it (cleanup row R4).
 */

setupDom();
// Toasts dismiss themselves on a timer; none needs to run here.
window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;

const { store } = await import('../ui/store.ts');
const { publishPlan } = await import('../shared/plan.ts');

const PLAN: Plan = publishPlan(null, { title: 'Add a cache', tasks: [{ title: 'Storage layer' }] }, Date.now()).plan;

function sessionFor(id: string, agent: AgentKind): SessionState {
  const now = Date.now();
  return { sessionId: id, agent, cwd: '/repo', repoRoot: '/repo', branch: 'main', title: 'repo', status: 'idle', waiting: null, surface: 'unknown', link: null, createdAt: now, updatedAt: now, plan: PLAN };
}

/** What the daemon answers to the next sign-off: set per case. */
let answer: (route: string) => unknown = () => ({ ok: true });
beforeEach(() => {
  answer = () => ({ ok: true });
});
const sessions = new Map<string, SessionState>();
const { posts } = stubFetch((route) => {
  if (route.startsWith('/api/session/') && route.includes('/plan/')) return answer(route);
  if (route.startsWith('/api/session/')) return { session: sessions.get(route.split('/')[3]!) };
  return { ok: true };
});

async function show(id: string, agent: AgentKind): Promise<void> {
  sessions.set(id, sessionFor(id, agent));
  await store.selectSession(id, false);
  assert.equal(store.getState().session?.plan?.title, PLAN.title);
}

const lastToast = () => store.getState().toasts.at(-1);
const shownPlan = () => store.getState().session?.plan;

interface SignOff {
  name: string;
  route: string;
  run: () => Promise<boolean>;
  body: Record<string, unknown>;
  kind: 'success' | 'info';
  said: RegExp;
}
const SIGN_OFFS: SignOff[] = [
  { name: 'submitPlan', route: 'plan/submit', run: () => store.submitPlan({ target: 'session', note: 'go', expect: 1 }), body: { target: 'session', note: 'go', expect: 1 }, kind: 'success', said: /^Plan submitted and locked\. Send any message in Claude to hand it the prompt\.$/ },
  { name: 'reopenPlan', route: 'plan/reopen', run: () => store.reopenPlan(), body: {}, kind: 'info', said: /^The plan is open for changes again\. Tell Claude in chat once you have changed it\.$/ },
  { name: 'confirmDesign', route: 'plan/design/confirm', run: () => store.confirmDesign({ note: '', expect: 1 }), body: { note: '', expect: 1 }, kind: 'success', said: /^Design confirmed\. Send any message in Claude to have it make the task list\.$/ },
  { name: 'reopenDesign', route: 'plan/design/reopen', run: () => store.reopenDesign(), body: {}, kind: 'info', said: /^The design is open for changes again\. Tell Claude in chat once you have changed it\.$/ },
  { name: 'queueRevision', route: 'plan/revisions', run: () => store.queueRevision({ note: 'tighten it', expect: 1 }), body: { note: 'tighten it', expect: 1 }, kind: 'success', said: /^Request queued\. Send any message in Claude's chat — "go" will do — and it goes with it\.$/ },
  { name: 'withdrawRevision', route: 'plan/revisions/withdraw', run: () => store.withdrawRevision(), body: {}, kind: 'info', said: /^Request withdrawn: it will not be sent\.$/ },
];

// First, while the (one, shared) store has no session on screen yet.
test('with no session on screen, nothing is signed off and nothing is sent', async () => {
  assert.equal(store.getState().sessionId, null);
  const sent = posts.length;
  for (const s of SIGN_OFFS) assert.equal(await s.run(), false, s.name);
  assert.equal(posts.length, sent);
});

test('a sign-off sends one request, adopts the answer, says so, and resolves true', async () => {
  await show('s1', 'claude');
  for (const s of SIGN_OFFS) {
    store.setTab('overview');
    const sent = posts.length;
    const toasts = store.getState().toasts.length;
    const newer = { ...shownPlan()!, version: shownPlan()!.version + 1, title: `after ${s.name}` };
    answer = () => ({ plan: newer });
    assert.equal(await s.run(), true, s.name);
    assert.deepEqual(posts.slice(sent), [{ route: `/api/session/s1/${s.route}`, body: s.body }], s.name);
    assert.equal(shownPlan()?.title, `after ${s.name}`, `${s.name} puts the answer in place`);
    assert.equal(store.getState().toasts.length, toasts + 1, `${s.name} says one thing`);
    assert.equal(lastToast()?.kind, s.kind, s.name);
    assert.match(lastToast()?.text ?? '', s.said, s.name);
    if (s.name !== 'submitPlan') assert.equal(store.getState().tab, 'overview', `${s.name} leaves the user where they were`);
  }
});

test('an answer older than what the page already shows is not put in place', async () => {
  await show('s2', 'claude');
  const current = { ...shownPlan()!, version: 50, title: 'newer, from the live stream' };
  store.apply({ type: 'snapshot', session: { ...sessionFor('s2', 'claude'), plan: current } });
  assert.equal(shownPlan()?.title, current.title);
  for (const s of SIGN_OFFS) {
    answer = () => ({ plan: { ...current, version: 49, title: 'stale answer' } });
    assert.equal(await s.run(), true, s.name);
    assert.equal(shownPlan()?.title, current.title, `${s.name} never rolls the page back`);
  }
  // The same version is the daemon's word on it: put in place.
  for (const s of SIGN_OFFS) {
    answer = () => ({ plan: { ...current, title: `same version, from ${s.name}` } });
    assert.equal(await s.run(), true, s.name);
    assert.equal(shownPlan()?.title, `same version, from ${s.name}`, s.name);
  }
});

test('an answer for a session the user has since left never lands on the one on screen', async () => {
  await show('s6', 'claude');
  // Another agent's session, so what is said can only be about one of them.
  await show('s7', 'cursor');
  const onScreen = shownPlan();
  for (const s of SIGN_OFFS) {
    await show('s6', 'claude');
    let land: (value: unknown) => void = () => {};
    answer = () => new Promise((resolve) => (land = resolve));
    const pending = s.run();
    await show('s7', 'cursor');
    store.setTab('overview');
    land({ plan: { ...PLAN, version: 99, title: `s6 after ${s.name}` } });
    await pending;
    assert.equal(store.getState().sessionId, 's7');
    assert.deepEqual(shownPlan(), onScreen, `${s.name}'s answer for s6 leaves s7 alone`);
    assert.equal(store.getState().tab, 'overview', `${s.name} does not move the page s7 is on`);
    assert.match(lastToast()?.text ?? '', new RegExp(`^"s6 after ${s.name}": `), `${s.name} says which plan it is about`);
    assert.doesNotMatch(lastToast()?.text ?? '', /Cursor/, `${s.name} speaks of s6's agent, not s7's`);
  }
});

test("an edit's answer is put in place the same way: newer or equal lands, older does not, another session's never", async () => {
  await show('s8', 'claude');
  const at = shownPlan()!.version;
  answer = () => ({ plan: { ...shownPlan()!, version: at + 1, title: 'edited' }, changes: [] });
  assert.equal((await store.commit([{ op: 'set_meta', title: 'edited' }], 's8'))?.title, 'edited');
  assert.equal(shownPlan()?.title, 'edited');
  answer = () => ({ plan: { ...shownPlan()!, version: at + 1, title: 'edited, same version' }, changes: [] });
  await store.commit([{ op: 'set_meta', title: 'x' }], 's8');
  assert.equal(shownPlan()?.title, 'edited, same version');
  answer = () => ({ plan: { ...shownPlan()!, version: at, title: 'stale edit' }, changes: [] });
  assert.equal((await store.commit([{ op: 'set_meta', title: 'x' }], 's8'))?.title, 'stale edit', 'the answer is returned');
  assert.equal(shownPlan()?.title, 'edited, same version', 'but not put in place');
  answer = () => ({ plan: { ...shownPlan()!, version: at + 5, title: 'for s1' }, changes: [] });
  await store.commit([{ op: 'set_meta', title: 'x' }], 's1');
  assert.equal(shownPlan()?.title, 'edited, same version', "another session's answer never lands here");
  answer = () => ({ __status: 400, error: 'No task "nope".' });
  assert.equal(await store.commit([{ op: 'remove', kind: 'task', id: 'nope' }], 's8'), null);
  assert.equal(lastToast()?.text, 'No task "nope".');
});

test('a refusal is shown in the daemon\'s words, changes nothing, and resolves false', async () => {
  await show('s3', 'claude');
  store.setTab('overview');
  const before = shownPlan();
  for (const s of SIGN_OFFS) {
    answer = () => ({ __status: 409, error: `Refused: ${s.name}.` });
    assert.equal(await s.run(), false, s.name);
    assert.equal(shownPlan(), before, `${s.name} leaves the plan alone`);
    assert.deepEqual({ kind: lastToast()?.kind, text: lastToast()?.text }, { kind: 'error', text: `Refused: ${s.name}.` }, s.name);
  }
  assert.equal(store.getState().tab, 'overview', 'a refused submit stays where the user was');
});

test('a submit moves the page to the task board', async () => {
  await show('s4', 'claude');
  store.setTab('overview');
  answer = () => ({ plan: { ...shownPlan()!, version: shownPlan()!.version + 1 } });
  assert.equal(await store.submitPlan({ target: 'session', note: '', expect: 1 }), true);
  assert.deepEqual({ tab: store.getState().tab, taskMode: store.getState().taskMode }, { tab: 'tasks', taskMode: 'board' });
});

test('what a sign-off says fits the agent and where the plan is built', async () => {
  await show('s5', 'cursor');
  const next = () => ({ plan: { ...shownPlan()!, version: shownPlan()!.version + 1 } });
  answer = next;
  await store.submitPlan({ target: 'session', note: '', expect: 1 });
  assert.equal(lastToast()?.text, "Plan submitted and locked. Paste the prompt into Cursor's chat.");
  await store.submitPlan({ target: 'elsewhere', note: '', expect: 1 });
  assert.equal(lastToast()?.text, 'Plan submitted and locked. Paste the prompt where it will be built.');
  await store.confirmDesign({ note: '', expect: 1 });
  assert.equal(lastToast()?.text, "Design confirmed. Paste the prompt into Cursor's chat to have it make the task list.");
  await store.queueRevision({ note: '', expect: 1 });
  assert.equal(lastToast()?.text, "Request queued. Paste it into Cursor's chat, or ask Cursor to read the plan.");

  // Reopening a plan whose design was confirmed keeps the design.
  answer = () => ({ plan: { ...shownPlan()!, version: shownPlan()!.version + 1, design: { at: 1, prompt: 'p' } } });
  await store.reopenPlan();
  assert.equal(lastToast()?.text, 'The tasks are open for changes again; the design stays confirmed. Tell Cursor in chat once you have changed them.');

  // A quiet revision request says nothing.
  answer = next;
  const toasts = store.getState().toasts.length;
  assert.equal(await store.queueRevision({ note: '', expect: 1 }, { quiet: true }), true);
  assert.equal(store.getState().toasts.length, toasts);
});
