import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { DiffPayload, SessionState } from '../shared/types.ts';

/**
 * The keyboard-and-screen-reader contract, and the layout decisions that go
 * with it.
 *
 * Each of these covers something that was actually wrong: a tab strip that
 * was six tab stops with no panel relationship, a diff whose every line was a
 * button whose label hid the code, a theme control that did nothing when the
 * OS disagreed with it, and a message box on tabs that could only queue
 * behind their own gate.
 */

setupDom();

const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');

const DIFF: DiffPayload = {
  baseRef: 'abc1234567890abc1234567890abc1234567890a',
  headRef: 'def',
  branch: 'feature/x',
  generatedAt: Date.now(),
  additions: 1,
  deletions: 1,
  includesWorkingTree: true,
  round: 1,
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      hunks: [
        {
          header: '',
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { kind: 'context', oldLine: 1, newLine: 1, text: 'export function add() {' },
            { kind: 'del', oldLine: 2, newLine: null, text: '  return 0;' },
            { kind: 'add', oldLine: null, newLine: 2, text: '  return 1;' },
          ],
        },
      ],
    },
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
    plan: null,
    todos: [],
    files: [],
    commands: [],
    timeline: [],
    threads: [],
    checks: [],
    gates: [
      {
        id: 'g1',
        kind: 'code_review',
        status: 'open',
        prompt: 'Review the diff',
        createdAt: Date.now() - 5_000,
        waiting: true,
      },
    ],
    activeGateId: 'g1',
    pendingFeedback: [],
    notes: [],
    usage: null,
    worktree: null,
    ship: null,
    ...overrides,
  } as SessionState;
}

async function boot(state: SessionState = makeSession()) {
  stubFetch((route) => {
    if (route.startsWith('/api/sessions')) {
      return {
        sessions: [
          {
            sessionId: 's1',
            title: 'demo',
            cwd: '/repo',
            repoName: 'repo',
            repoRoot: '/repo',
            branch: 'feature/x',
            stage: state.stage,
            status: state.status,
            updatedAt: Date.now(),
            openGates: state.gates.filter((g) => g.status === 'open').length,
            pendingFeedback: 0,
            tasks: { total: 0, done: 0, blocked: 0 },
          },
        ],
        version: 'test',
      };
    }
    if (route.startsWith('/api/session/s1/diff')) return { diff: DIFF };
    if (route.startsWith('/api/session/s1')) return { session: state, diff: DIFF };
    return { ok: true };
  });
  render(<App />);
  await act(async () => {
    await store.init();
  });
}

beforeEach(() => {
  // Unmount first: a test that fails part way through never reaches its own
  // cleanup, and a second App in the document turns every later failure into
  // "found multiple elements".
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  store.set({ drafts: {}, toasts: [], session: null, diff: null, sessionId: null, selectedFile: null });
});

after(() => cleanup());

/* ------------------------------------------------------- tab semantics */

test('the tab strip is one tab stop, and each tab owns its panel', async () => {
  await boot();

  const tabs = screen.getAllByRole('tab');
  assert.equal(tabs.length, 6);

  const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1, 'exactly one tab is selected');

  // Roving tabindex: the strip is a single stop, not six.
  assert.equal(selected[0]!.getAttribute('tabindex'), '0');
  for (const tab of tabs.filter((t) => t !== selected[0])) {
    assert.equal(tab.getAttribute('tabindex'), '-1');
  }

  const panel = screen.getByRole('tabpanel');
  assert.equal(panel.id, selected[0]!.getAttribute('aria-controls'));
  assert.equal(panel.getAttribute('aria-labelledby'), selected[0]!.id);
  cleanup();
});

test('arrow keys move between tabs and wrap at the ends', async () => {
  await boot();
  act(() => store.setTab('timeline'));

  const strip = document.querySelector('.tabs')!;
  fireEvent.keyDown(strip, { key: 'ArrowRight' });
  assert.equal(store.getState().tab, 'plan');

  fireEvent.keyDown(strip, { key: 'ArrowLeft' });
  assert.equal(store.getState().tab, 'timeline');

  // Left from the first tab wraps to the last rather than doing nothing.
  fireEvent.keyDown(strip, { key: 'ArrowLeft' });
  assert.equal(store.getState().tab, 'ship');

  fireEvent.keyDown(strip, { key: 'Home' });
  assert.equal(store.getState().tab, 'timeline');

  fireEvent.keyDown(strip, { key: 'End' });
  assert.equal(store.getState().tab, 'ship');
  cleanup();
});

test('the first tab is the Conversation, and the old name is gone', async () => {
  await boot();
  const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
  assert.match(tabs[0] ?? '', /Conversation/);
  assert.equal(
    tabs.some((t) => /Activity/.test(t ?? '')),
    false,
    'the old name is gone rather than duplicated',
  );

  // The view's own heading has to agree with the tab that opens it; two names
  // for one place is the thing the rename was meant to remove.
  act(() => store.setTab('timeline'));
  const heading = document.querySelector('.feed-head strong');
  assert.equal(heading?.textContent, 'Conversation');
  cleanup();
});

/* ------------------------------------------------- composer placement */

test('the message box is on the Conversation tab and nowhere else', async () => {
  await boot();

  // Booted onto Review, because that is where the open gate is.
  assert.equal(store.getState().tab, 'review');
  assert.equal(document.querySelector('.composer'), null, 'no message box on a gated stage tab');
  assert.ok(document.querySelector('.talk-hint'), 'it points at the tab that does have one');

  act(() => store.setTab('timeline'));
  assert.ok(document.querySelector('.composer'), 'the Conversation has the message box');
  assert.equal(document.querySelector('.talk-hint'), null);
  cleanup();
});

test('the pointer back to the Conversation actually goes there', async () => {
  await boot();
  fireEvent.click(screen.getByRole('button', { name: /say something instead/i }));
  assert.equal(store.getState().tab, 'timeline');
  cleanup();
});

/* --------------------------------------------------------- the diff */

test('a diff line is readable text, not a button that hides the code', async () => {
  await boot();
  const row = document.querySelector('.drow.is-add')!;

  assert.equal(row.getAttribute('role'), null, 'the row carries no widget role');
  assert.equal(row.getAttribute('tabindex'), null, 'and is not its own tab stop');
  assert.equal(
    row.getAttribute('aria-label'),
    null,
    'a label here would replace the line of code it is meant to describe',
  );
  assert.match(row.textContent ?? '', /return 1;/, 'the code is what gets read');
  cleanup();
});

test('every line offers a named button to comment on it', async () => {
  await boot();

  // Both sides of this hunk are numbered 2, so the names have to say which
  // side they act on or they are two identical buttons doing different things.
  const added = screen.getByRole('button', { name: 'Comment on src/app.ts, added line 2' });
  assert.ok(screen.getByRole('button', { name: 'Comment on src/app.ts, removed line 2' }));

  fireEvent.click(added);
  assert.ok(document.querySelector('.dcomposer'), 'it opens the comment composer');
  cleanup();
});

/* -------------------------------------------------------- the theme */

test('choosing a theme wins over the system preference', async () => {
  await boot();

  // The bug this replaces: dark tokens lived only inside a
  // prefers-color-scheme media query, so on a light-OS machine picking Dark
  // set an attribute that no rule matched and nothing changed.
  fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');

  fireEvent.click(screen.getByRole('button', { name: 'Light' }));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  cleanup();
});

test('the theme is always resolved to an explicit attribute, never left blank', async () => {
  await boot();
  fireEvent.click(screen.getByRole('button', { name: 'Match the system' }));

  const resolved = document.documentElement.getAttribute('data-theme');
  assert.ok(
    resolved === 'light' || resolved === 'dark',
    `system resolves to a concrete theme, got ${resolved}`,
  );
  cleanup();
});

/* --------------------------------------------------- names and regions */

test('icon-only controls carry a name rather than a glyph', async () => {
  await boot();

  for (const name of [/collapse sidebar/i, /rename demo/i, /pin demo/i, /delete demo/i]) {
    assert.ok(screen.getByRole('button', { name }), `missing an accessible name for ${name}`);
  }
  cleanup();
});

test('the live region and the skip link are always in the document', async () => {
  await boot();

  // Mounted while empty on purpose: a region inserted at the same moment as
  // its first message is routinely never announced.
  assert.equal(store.getState().toasts.length, 0);
  assert.ok(document.querySelector('.toasts[aria-live="polite"]'), 'the toast region stays mounted');

  const skip = document.querySelector('.skip-link') as HTMLAnchorElement | null;
  assert.ok(skip, 'there is a skip link');
  assert.equal(skip!.getAttribute('href'), `#${screen.getByRole('tabpanel').id}`);
  cleanup();
});
