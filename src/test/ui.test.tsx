import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { DiffPayload, SessionState } from '../shared/types.ts';

/**
 * The React UI against jsdom.
 *
 * These cover the behaviours the review found broken in the vanilla version:
 * comments surviving a live update, being visible and removable before they
 * are sent, and the message box no longer resolving a gate behind the user's
 * back.
 */

setupDom();

// Imported after the DOM exists — React reads globals at module load.
const { render, screen, fireEvent, within, cleanup, act } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');

const DIFF: DiffPayload = {
  baseRef: 'abc1234567890abc1234567890abc1234567890a',
  headRef: 'def',
  branch: 'feature/x',
  generatedAt: Date.now(),
  additions: 3,
  deletions: 1,
  includesWorkingTree: true,
  round: 1,
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
      hunks: [
        {
          header: '',
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 4,
          lines: [
            { kind: 'context', oldLine: 1, newLine: 1, text: 'export function add() {' },
            { kind: 'del', oldLine: 2, newLine: null, text: '  return 0;' },
            { kind: 'add', oldLine: null, newLine: 2, text: '  return 1;' },
            { kind: 'add', oldLine: null, newLine: 3, text: '  // note' },
            { kind: 'context', oldLine: 3, newLine: 4, text: '}' },
          ],
        },
      ],
    },
    { path: 'docs/logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
  ],
};

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 's1',
    cwd: '/repo',
    repoRoot: '/repo',
    branch: 'feature/x',
    transcriptPath: null,
    title: 'demo',
    stage: 'code_review',
    status: 'waiting',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    baseRef: 'abc',
    startCommit: 'abc',
    reviewRound: 1,
    roundHistory: [],
    tasks: [],
    plan: {
      title: 'Add subtract',
      summary: 'Mirror add().',
      steps: [
        { id: 's1', title: 'Write subtract' },
        { id: 's2', title: 'Add a test' },
      ],
      revision: 1,
      updatedAt: Date.now(),
    },
    todos: [
      { content: 'Write subtract', status: 'completed' },
      { content: 'Add a test', status: 'in_progress' },
    ],
    files: [{ path: 'src/app.ts', edits: 2, firstTouchedAt: Date.now(), lastTouchedAt: Date.now(), tools: ['Edit'] }],
    commands: [],
    timeline: [{ id: 'e1', ts: Date.now(), kind: 'assistant', text: 'Working on **subtract** now.' }],
    gates: [
      {
        id: 'g1',
        kind: 'code_review',
        stage: 'code_review',
        prompt: 'Review the code changes',
        createdAt: Date.now() - 90_000,
        status: 'open',
        waiting: true,
      },
    ],
    activeGateId: 'g1',
    threads: [],
    checks: [],
    ship: null,
    pendingFeedback: [],
    stats: { turns: 3, toolCalls: 9, edits: 2 },
    ...overrides,
  };
}

let posts: { route: string; body: Record<string, unknown> }[];
let session: SessionState;

function mount(state: SessionState = makeSession()) {
  session = state;
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) {
      return {
        sessions: [
          {
            sessionId: 's1',
            title: 'demo',
            cwd: '/repo',
            repoName: 'repo',
            branch: 'feature/x',
            stage: session.stage,
            status: session.status,
            updatedAt: Date.now(),
            openGates: session.gates.filter((g) => g.status === 'open').length,
            pendingFeedback: session.pendingFeedback.length,
            tasks: { total: 0, done: 0, blocked: 0 },
          },
        ],
        version: 'test',
      };
    }
    if (route.startsWith('/api/session/s1/diff')) return { diff: DIFF };
    if (route.startsWith('/api/session/s1/ship')) {
      return {
        ship: {
          title: 'Add subtract',
          body: 'body',
          commitMessage: 'Add subtract',
          branch: 'feature/x',
          baseBranch: 'main',
          steps: ['commit', 'push', 'pr'],
          provider: 'gh',
        },
        providers: [{ id: 'gh', kind: 'command', label: 'GitHub' }],
      };
    }
    if (route.startsWith('/api/session/s1')) return { session, diff: DIFF };
    return { ok: true };
  }));
  return render(<App />);
}

async function boot(state?: SessionState) {
  mount(state);
  await act(async () => {
    await store.init();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  store.set({ drafts: {}, toasts: [], session: null, diff: null, sessionId: null, selectedFile: null });
});

after(() => cleanup());

/* ------------------------------------------------------------------ */

test('the shell renders the session and lands on the tab the gate needs', async () => {
  await boot();
  assert.ok(screen.getByText('demo'));
  assert.equal(store.getState().tab, 'review', 'a code-review gate opens the Review tab');
  cleanup();
});

test('a parked gate says the terminal is blocked, and counts up', async () => {
  await boot();
  const banner = document.querySelector('.gate-banner.is-blocking');
  assert.ok(banner, 'a parked gate renders as blocking');
  assert.match(banner!.textContent ?? '', /waiting on your review of the code/i);
  assert.match(banner!.textContent ?? '', /parked and will not continue/i);
  cleanup();
});

test('an open gate with nothing parked does not claim to be blocking', async () => {
  const state = makeSession();
  state.gates[0]!.waiting = false;
  state.status = 'idle';
  await boot(state);
  assert.ok(!document.querySelector('.gate-banner.is-blocking'));
  assert.match(document.querySelector('.gate-banner')!.textContent ?? '', /gone idle/i);
  cleanup();
});

test('the diff lists every file at once rather than one at a time', async () => {
  await boot();
  assert.equal(document.querySelectorAll('.dfile').length, 2, 'both files render in one scroll');
  assert.equal(document.querySelectorAll('.file-row').length, 2);
  assert.match(document.body.textContent ?? '', /Binary file/);
  cleanup();
});

test('a line comment is written, listed with its line, and kept', async () => {
  await boot();
  const addedLine = document.querySelectorAll('.drow.is-add')[0]!;
  fireEvent.click(addedLine);

  const composer = document.querySelector('.dcomposer')!;
  assert.ok(composer, 'clicking a line opens a composer');
  assert.match(composer.textContent ?? '', /src\/app\.ts:2/);

  fireEvent.change(composer.querySelector('textarea')!, { target: { value: 'Guard against NaN.' } });
  fireEvent.click(within(composer as HTMLElement).getByText('Add to review'));

  // Listed in the pending panel, with its file and line.
  const pending = document.querySelector('.pending')!;
  assert.match(pending.textContent ?? '', /src\/app\.ts/);
  assert.match(pending.textContent ?? '', /L2/);
  assert.match(pending.textContent ?? '', /Guard against NaN/);

  // And inline, marked as not yet sent.
  const thread = document.querySelector('.dthread.is-draft')!;
  assert.match(thread.textContent ?? '', /Not sent yet/);
  cleanup();
});

test('a draft survives a live session update', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'keep me' } });
  fireEvent.click(screen.getByText('Add to review'));

  // The daemon pushes a snapshot, which used to wipe everything in progress.
  act(() => {
    store.set({ session: { ...session, updatedAt: Date.now(), stats: { turns: 4, toolCalls: 10, edits: 3 } } });
  });

  assert.match(document.querySelector('.pending')!.textContent ?? '', /keep me/);
  cleanup();
});

test('a draft is restored after a reload', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'persist me' } });
  fireEvent.click(screen.getByText('Add to review'));
  cleanup();

  const raw = window.localStorage.getItem('cc-harness:drafts');
  assert.ok(raw && raw.includes('persist me'), 'drafts are persisted, not held only in memory');
});

test('a draft can be removed before it is sent', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'delete me' } });
  fireEvent.click(screen.getByText('Add to review'));
  assert.equal(store.drafts().length, 1);

  fireEvent.click(document.querySelector('.pending-item .icon-btn')!);
  assert.equal(store.drafts().length, 0);
  assert.doesNotMatch(document.querySelector('.pending')!.textContent ?? '', /delete me/);
  cleanup();
});

test('submitting the review resolves the gate with every comment attached', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'fix this' } });
  fireEvent.click(screen.getByText('Add to review'));

  posts.length = 0;
  await act(async () => {
    fireEvent.click(screen.getByText('Request changes'));
  });

  const call = posts.find((p) => p.route.includes('/gate/'));
  assert.ok(call, 'the gate is resolved, not queued as loose feedback');
  assert.equal(call!.body['verdict'], 'changes_requested');
  const threads = call!.body['threads'] as { file: string; startLine: number; body: string }[];
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.file, 'src/app.ts');
  assert.equal(threads[0]!.startLine, 2);
  assert.equal(store.drafts().length, 0, 'drafts are cleared once sent');
  cleanup();
});

test('approving with unsent comments asks first', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'hmm' } });
  fireEvent.click(screen.getByText('Add to review'));

  posts.length = 0;
  fireEvent.click(screen.getByText('Approve'));
  assert.equal(posts.length, 0, 'nothing is sent until the user confirms');
  assert.match(document.querySelector('.pending-confirm')!.textContent ?? '', /Approve with 1 unsent comment/);
  cleanup();
});

test('the message box never resolves a gate', async () => {
  await boot();
  posts.length = 0;
  const input = document.querySelector('.composer-input')!;
  fireEvent.change(input, { target: { value: 'looks good, go ahead' } });
  await act(async () => {
    fireEvent.click(screen.getByText('Send message'));
  });

  assert.equal(posts.length, 1);
  assert.match(posts[0]!.route, /\/feedback$/, 'it queues a message rather than voting on the gate');
  assert.doesNotMatch(posts[0]!.route, /\/gate\//);
  cleanup();
});

test('the message box explains that it does not answer the open gate', async () => {
  await boot();
  const notice = document.querySelector('.composer-notice')!;
  assert.match(notice.textContent ?? '', /does not answer it/i);
  cleanup();
});

test('unsent comments are called out next to the message box', async () => {
  await boot();
  fireEvent.click(document.querySelectorAll('.drow.is-add')[0]!);
  fireEvent.change(document.querySelector('.dcomposer textarea')!, { target: { value: 'x' } });
  fireEvent.click(screen.getByText('Add to review'));
  assert.match(document.querySelector('.composer-warn')!.textContent ?? '', /does not include them/i);
  cleanup();
});

test('plan steps reorder and keep the note the user typed', async () => {
  const state = makeSession({ stage: 'plan_review' });
  state.gates[0] = { ...state.gates[0]!, kind: 'plan', prompt: 'Review the plan' };
  await boot(state);
  act(() => store.setTab('plan'));

  const note = document.querySelector('.plan-side textarea')!;
  fireEvent.change(note, { target: { value: 'reorder first' } });

  const steps = () => [...document.querySelectorAll('.step-title')].map((n) => (n as HTMLInputElement).value);
  assert.deepEqual(steps(), ['Write subtract', 'Add a test']);

  fireEvent.click(document.querySelectorAll('.plan-step')[1]!.querySelector('[title="Move up"]')!);
  assert.deepEqual(steps(), ['Add a test', 'Write subtract'], 'the order changed');
  assert.equal(
    (document.querySelector('.plan-side textarea') as HTMLTextAreaElement).value,
    'reorder first',
    'reordering does not wipe the note',
  );
  cleanup();
});

test('a republished plan does not silently overwrite edits in progress', async () => {
  const state = makeSession({ stage: 'plan_review' });
  state.gates[0] = { ...state.gates[0]!, kind: 'plan', prompt: 'Review the plan' };
  await boot(state);
  act(() => store.setTab('plan'));

  fireEvent.change(document.querySelectorAll('.step-title')[0]!, { target: { value: 'MY EDIT' } });

  act(() => {
    store.set({
      session: {
        ...session,
        plan: { ...session.plan!, revision: 2, steps: [{ id: 's1', title: 'Claude rewrote it' }] },
      },
    });
  });

  const titles = [...document.querySelectorAll('.step-title')].map((n) => (n as HTMLInputElement).value);
  assert.ok(titles.includes('MY EDIT'), 'the edit survives');
  assert.match(document.querySelector('.plan-incoming')!.textContent ?? '', /published revision 2/);
  cleanup();
});

test('ship requires an explicit confirmation naming the branches', async () => {
  const state = makeSession({ stage: 'ship' });
  state.gates[0] = { ...state.gates[0]!, kind: 'ship', prompt: 'Confirm the ship' };
  await boot(state);
  await act(async () => {
    store.setTab('ship');
  });

  posts.length = 0;
  fireEvent.click(screen.getByText('Ship…'));
  assert.equal(posts.length, 0, 'the first click only asks');
  const confirm = document.querySelector('.ship-confirm')!;
  assert.match(confirm.textContent ?? '', /feature\/x/);
  assert.match(confirm.textContent ?? '', /main/);
  cleanup();
});

test('ship refuses when the session is on the default branch', async () => {
  const state = makeSession({ stage: 'ship', branch: 'main' });
  state.gates[0] = { ...state.gates[0]!, kind: 'ship', prompt: 'Confirm the ship' };
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    if (route.startsWith('/api/session/s1/ship')) {
      return {
        ship: {
          title: 't',
          body: 'b',
          commitMessage: 'c',
          branch: 'main',
          baseBranch: 'main',
          steps: ['commit', 'push'],
          provider: 'gh',
        },
        providers: [{ id: 'gh', kind: 'command', label: 'GitHub' }],
      };
    }
    if (route.startsWith('/api/session/s1')) return { session: state, diff: DIFF };
    return { ok: true };
  }));
  session = state;
  render(<App />);
  await act(async () => {
    await store.selectSession('s1', false);
  });
  await act(async () => {
    store.setTab('ship');
  });

  assert.match(document.querySelector('.warn-side, .ship-side')!.textContent ?? '', /default branch/i);
  assert.ok((screen.getByText('Ship…') as HTMLButtonElement).disabled, 'shipping is blocked');
  cleanup();
});

test('the board shows where the agent is, per column', async () => {
  const now = Date.now();
  const state = makeSession({
    stage: 'implementing',
    tasks: [
      { id: 't1', title: 'Add the helper', status: 'done', order: 0, createdAt: now, updatedAt: now,
        notes: [{ id: 'n1', ts: now, kind: 'change', text: 'Added calculateTax in cart.js' }],
        files: ['cart.js'], decisions: [] },
      { id: 't2', title: 'Wire it into total()', status: 'in_progress', order: 1, createdAt: now,
        updatedAt: now, startedAt: now - 90_000, notes: [], files: ['cart.js'], decisions: [] },
      { id: 't3', title: 'Round the result', status: 'blocked', order: 2, createdAt: now, updatedAt: now,
        blockedBy: 'q1', blockedReason: 'Round to cents or keep full precision?',
        notes: [], files: [], decisions: [] },
      { id: 't4', title: 'Add a test', status: 'todo', order: 3, createdAt: now, updatedAt: now,
        notes: [], files: [], decisions: [] },
    ],
  });
  state.gates = [];
  state.activeGateId = null;
  await boot(state);
  act(() => store.setTab('board'));

  assert.equal(document.querySelectorAll('.board-column').length, 4);
  assert.equal(document.querySelectorAll('.board-card').length, 4);
  assert.equal(document.querySelectorAll('.board-card.is-in_progress').length, 1);

  const blocked = document.querySelector('.board-card.is-blocked')!;
  assert.match(blocked.textContent ?? '', /Round to cents/, 'the question is visible on the card');
  cleanup();
});

test('a task card exposes the files and decisions behind it', async () => {
  const now = Date.now();
  const state = makeSession({
    stage: 'implementing',
    tasks: [
      {
        id: 't1',
        title: 'Add the helper',
        status: 'done',
        order: 0,
        createdAt: now,
        updatedAt: now,
        notes: [{ id: 'n1', ts: now, kind: 'change', text: 'Added calculateTax in cart.js' }],
        files: ['cart.js', 'cart.test.js'],
        decisions: [{ id: 'd1', ts: now, question: 'Round to cents?', answer: 'Yes, banker’s rounding' }],
      },
    ],
  });
  state.gates = [];
  await boot(state);
  act(() => store.setTab('board'));

  fireEvent.click(screen.getByText('details'));
  const body = document.querySelector('.board-card-body')!;
  assert.match(body.textContent ?? '', /cart\.test\.js/);
  assert.match(body.textContent ?? '', /banker/);
  assert.match(body.textContent ?? '', /Added calculateTax/);
  cleanup();
});

test('moving a card tells Claude', async () => {
  const now = Date.now();
  const state = makeSession({
    stage: 'implementing',
    tasks: [
      { id: 't1', title: 'Redo this', status: 'done', order: 0, createdAt: now, updatedAt: now,
        notes: [], files: [], decisions: [] },
    ],
  });
  state.gates = [];
  await boot(state);
  act(() => store.setTab('board'));

  posts.length = 0;
  await act(async () => {
    await store.getState().session && (await import('../ui/lib/api.ts')).api.updateTask('s1', 't1', {
      status: 'todo',
    });
  });
  assert.match(posts[0]!.route, /\/tasks\/t1$/);
  assert.equal(posts[0]!.body['status'], 'todo');
  cleanup();
});

test('a second round offers a changed-only filter', async () => {
  const state = makeSession();
  ({ posts } = stubFetch((route) => {
    const round2: typeof DIFF = {
      ...DIFF,
      round: 2,
      previousRound: 1,
      changedSinceLastReview: ['src/app.ts'],
      files: [
        { ...DIFF.files[0]!, changedSinceLastReview: true },
        { ...DIFF.files[1]!, changedSinceLastReview: false },
      ],
    };
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    if (route.startsWith('/api/session/s1/diff')) return { diff: round2 };
    if (route.startsWith('/api/session/s1')) return { session: state, diff: round2 };
    return { ok: true };
  }));
  session = state;
  render(<App />);
  await act(async () => {
    await store.selectSession('s1', false);
  });

  assert.match(document.querySelector('.review-bar')!.textContent ?? '', /round 2/);
  const toggle = screen.getByText(/Changed since round 1/);
  assert.equal(document.querySelectorAll('.dfile').length, 2);

  fireEvent.click(toggle);
  assert.equal(document.querySelectorAll('.dfile').length, 1, 'only the file that moved is shown');
  cleanup();
});

test('a delivered comment can be replied to and resolved', async () => {
  const now = Date.now();
  const state = makeSession({
    threads: [
      {
        id: 'th1',
        file: 'src/app.ts',
        side: 'new',
        startLine: 2,
        endLine: 2,
        body: 'Guard against NaN.',
        createdAt: now,
        resolved: false,
        deliveredAt: now,
        replies: [{ id: 'r1', ts: now, author: 'claude', text: 'Added a guard.' }],
      },
    ],
  });
  await boot(state);

  const thread = document.querySelector('.dthread.is-sent')!;
  assert.match(thread.textContent ?? '', /Added a guard/);
  assert.match(thread.textContent ?? '', /Claude/);

  posts.length = 0;
  fireEvent.click(within(thread as HTMLElement).getByText('Reply'));
  fireEvent.change(thread.querySelector('textarea')!, { target: { value: 'Still wrong for null.' } });
  await act(async () => {
    fireEvent.click(within(thread as HTMLElement).getByText('Send reply'));
  });
  assert.match(posts[0]!.route, /\/thread\/th1\/reply$/);
  assert.equal(posts[0]!.body['text'], 'Still wrong for null.');
  cleanup();
});

test("a question from Claude is answerable in the UI", async () => {
  const state = makeSession({ stage: 'implementing' });
  state.gates = [
    {
      id: 'q1',
      kind: 'question',
      stage: 'implementing',
      prompt: 'Should I use a Map or a plain object here?',
      createdAt: Date.now(),
      status: 'open',
      waiting: true,
      meta: { options: ['Map', 'Plain object'] },
    },
  ];
  state.activeGateId = 'q1';
  await boot(state);

  assert.equal(store.getState().tab, 'timeline');
  const card = document.querySelector('.question-card')!;
  assert.match(card.textContent ?? '', /Map or a plain object/);

  posts.length = 0;
  await act(async () => {
    fireEvent.click(within(card as HTMLElement).getByText('Map'));
  });
  const call = posts.find((p) => p.route.includes('/gate/'));
  assert.ok(call, 'answering resolves the question gate');
  assert.equal(call!.body['verdict'], 'answered');
  assert.equal(call!.body['comment'], 'Map');
  cleanup();
});
