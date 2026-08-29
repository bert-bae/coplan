import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { SessionState, SessionSummary } from '../shared/types.ts';

/**
 * The session rail: grouping by project, pinning, and deletion.
 *
 * The rail is the only way to reach a session that is not the current one, so
 * these cover the things that would strand a user — a fold that hides the
 * session they are reading, a delete that leaves the pane empty, a pin that
 * does not survive a reload.
 */

setupDom();

const { render, fireEvent, within, cleanup, act, screen } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');

function makeSession(): SessionState {
  const now = Date.now();
  return {
    sessionId: 's1',
    cwd: '/repo',
    repoRoot: '/repo',
    branch: 'main',
    transcriptPath: null,
    title: 's1 title',
    stage: 'implementing',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    baseRef: null,
    startCommit: null,
    reviewRound: 0,
    roundHistory: [],
    tasks: [],
    plan: null,
    todos: [],
    files: [],
    commands: [],
    timeline: [],
    gates: [],
    activeGateId: null,
    threads: [],
    checks: [],
    ship: null,
    pendingFeedback: [],
    stats: { turns: 0, toolCalls: 0, edits: 0 },
  };
}

/** A summary row for the rail. */
function summary(sessionId: string, repo: string, updatedAt: number): SessionSummary {
  return {
    sessionId,
    title: `${sessionId} title`,
    cwd: `/${repo}`,
    repoName: repo,
    repoRoot: `/${repo}`,
    branch: 'main',
    stage: 'implementing',
    status: 'active',
    updatedAt,
    openGates: 0,
    pendingFeedback: 0,
    tasks: { total: 0, done: 0, blocked: 0 },
  };
}

let posts: { route: string; body: Record<string, unknown> }[];

const SESSIONS = () => {
  const now = Date.now();
  return [summary('s1', 'repo', now), summary('s2', 'other', now - 1000), summary('s3', 'other', now - 2000)];
};

async function boot(): Promise<void> {
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: SESSIONS(), version: 'test' };
    if (route.startsWith('/api/session/')) return { session: makeSession(), diff: null };
    return { ok: true };
  }));
  render(<App />);
  await act(async () => {
    await store.init();
  });
}

const groupNames = (): string[] =>
  [...document.querySelectorAll('.session-group-name')].map((el) => el.textContent ?? '');

const rowNames = (): string[] =>
  [...document.querySelectorAll('.session-row .session-name')].map((el) => el.textContent ?? '');

const rowFor = (text: string): HTMLElement =>
  [...document.querySelectorAll('.session-row')].find((el) =>
    (el.textContent ?? '').includes(text),
  ) as HTMLElement;

const groupHeadFor = (text: string): HTMLElement =>
  [...document.querySelectorAll('.session-group-head')].find((el) =>
    (el.textContent ?? '').includes(text),
  ) as HTMLElement;

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store.set({
    sessions: [],
    sessionId: null,
    session: null,
    diff: null,
    drafts: {},
    toasts: [],
    pinned: [],
    collapsedProjects: [],
    collapsedSidebar: false,
  });
});

after(() => cleanup());

/* ------------------------------------------------------------------ */

test('sessions are grouped by the project they run in', async () => {
  await boot();
  assert.deepEqual(groupNames(), ['repo', 'other'], 'most recently active project first');
  const counts = [...document.querySelectorAll('.session-group-count')].map((el) => el.textContent);
  assert.deepEqual(counts, ['1', '2']);
  assert.deepEqual(rowNames(), ['s1 title', 's2 title', 's3 title']);
});

test('a project group folds away, and the fold is remembered', async () => {
  await boot();
  const other = groupHeadFor('other');
  await act(async () => {
    fireEvent.click(other);
  });

  assert.deepEqual(rowNames(), ['s1 title'], 'the folded project hides its sessions');
  assert.equal(other.getAttribute('aria-expanded'), 'false');
  assert.ok(store.getState().collapsedProjects.includes('/other'));

  const saved = JSON.parse(window.localStorage.getItem('cc-harness:prefs') ?? '{}') as {
    collapsedProjects?: string[];
  };
  assert.deepEqual(saved.collapsedProjects, ['/other'], 'the fold survives a reload');
});

test('the group holding the open session stays open', async () => {
  await boot();
  assert.equal(store.getState().sessionId, 's1');
  await act(async () => {
    fireEvent.click(groupHeadFor('repo'));
  });
  // The preference is recorded, but folding away the session being read would
  // leave the main pane pointing at something the rail no longer shows.
  assert.ok(store.getState().collapsedProjects.includes('/repo'));
  assert.ok(rowNames().includes('s1 title'));
});

test('a pinned session moves to its own group at the top', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(within(rowFor('s3 title')).getByTitle('Pin session'));
  });

  assert.deepEqual(groupNames(), ['Pinned', 'repo', 'other']);
  assert.deepEqual(store.getState().pinned, ['s3']);
  assert.match(document.querySelector('.session-group')?.textContent ?? '', /s3 title/);

  const saved = JSON.parse(window.localStorage.getItem('cc-harness:prefs') ?? '{}') as {
    pinned?: string[];
  };
  assert.deepEqual(saved.pinned, ['s3'], 'a pin is the reader’s own preference and outlives the tab');

  await act(async () => {
    fireEvent.click(within(rowFor('s3 title')).getByTitle('Unpin session'));
  });
  assert.deepEqual(groupNames(), ['repo', 'other'], 'unpinning puts it back with its project');
});

test('deleting a session asks first, then deletes it for good', async () => {
  await boot();
  posts.length = 0;

  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByTitle('Delete session'));
  });
  assert.equal(posts.length, 0, 'the first click only asks');
  assert.match(rowFor('s2 title').textContent ?? '', /Delete permanently\?/);

  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByText('Delete'));
  });

  const call = posts.find((p) => p.route.endsWith('/api/session/s2'));
  assert.ok(call, 'confirming sends the delete');
  assert.ok(!rowNames().includes('s2 title'), 'the row goes away');
});

test('cancelling a delete leaves the session alone', async () => {
  await boot();
  posts.length = 0;

  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByTitle('Delete session'));
  });
  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByText('Cancel'));
  });

  assert.equal(posts.length, 0);
  assert.ok(rowNames().includes('s2 title'));
});

test('deleting the open session moves to another one', async () => {
  await boot();
  assert.equal(store.getState().sessionId, 's1');

  await act(async () => {
    fireEvent.click(within(rowFor('s1 title')).getByTitle('Delete session'));
  });
  await act(async () => {
    fireEvent.click(within(rowFor('s1 title')).getByText('Delete'));
  });

  // Deleting what you were reading must not dead-end on an empty pane.
  assert.equal(store.getState().sessionId, 's2');
});

test('deleting a session forgets the local state hanging off it', async () => {
  await boot();
  // Flushed before the click: pinning re-parents the row into the Pinned
  // group, which remounts it and would drop the confirm mid-test.
  await act(async () => {
    store.set({
      drafts: {
        s2: [
          {
            id: 'c1',
            file: 'a.ts',
            side: 'new',
            startLine: 1,
            endLine: 1,
            body: 'note',
            createdAt: Date.now(),
            resolved: false,
            draft: true,
          },
        ],
      },
      pinned: ['s2'],
    });
  });

  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByTitle('Delete session'));
  });
  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByText('Delete'));
  });

  // Nothing else will ever clean these up: the session id is gone for good.
  assert.equal(store.getState().drafts['s2'], undefined);
  assert.deepEqual(store.getState().pinned, []);
});

test('collapsing the sidebar narrows the column it sits in', async () => {
  await boot();
  assert.ok(!document.querySelector('.app')?.classList.contains('is-sidebar-collapsed'));
  await act(async () => {
    fireEvent.click(screen.getByTitle('Collapse sidebar'));
  });
  // Without this the rail shrinks but its grid column does not, leaving a band
  // of dead space where the sidebar used to be.
  assert.ok(document.querySelector('.app')?.classList.contains('is-sidebar-collapsed'));
});
