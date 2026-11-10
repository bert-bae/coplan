import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { SessionState, SessionSummary } from '../shared/types.ts';

/**
 * The session rail: grouping by project, pinning, deletion, and the
 * daemon-wide actions in its footer.
 *
 * The rail is the only way to reach a session that is not the current one, so
 * these cover the things that would strand a user — a fold that hides the
 * session they are reading, a delete that leaves the pane empty, a pin that
 * does not survive a reload.
 */

setupDom();

const { render, fireEvent, within, cleanup, act, screen, waitFor } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');

function makeSession(): SessionState {
  const now = Date.now();
  return {
    sessionId: 's1',
    agent: 'claude',
    cwd: '/repo',
    repoRoot: '/repo',
    branch: 'main',
    title: 's1 title',
    status: 'active',
    waiting: null,
    surface: 'unknown',
    link: null,
    createdAt: now,
    updatedAt: now,
    plan: null,
  };
}

/** A summary row for the rail. The rail orders on `createdAt`, so activity
 *  (`updatedAt`) is a separate argument the ordering tests can move on its own. */
function summary(sessionId: string, repo: string, createdAt: number, updatedAt: number = createdAt): SessionSummary {
  return {
    sessionId,
    agent: 'claude',
    title: `${sessionId} title`,
    planTitle: null,
    cwd: `/${repo}`,
    repoName: repo,
    repoRoot: `/${repo}`,
    branch: 'main',
    status: 'active',
    createdAt,
    updatedAt,
    tasks: { total: 0, done: 0, inProgress: 0, blocked: 0 },
    phase: 'planning',
    planStatus: 'planning',
    awaitingReview: 0,
    current: null,
    waiting: null,
    surface: 'unknown',
    link: null,
    openThreads: 0,
    unreadByClaude: 0,
    engaged: true,
    hooked: true,
  };
}

let posts: { route: string; body: Record<string, unknown> }[];

const SESSIONS = () => {
  const now = Date.now();
  return [summary('s1', 'repo', now), summary('s2', 'other', now - 1000), summary('s3', 'other', now - 2000)];
};

/** A storage report with one group of each consequence. `scale` of 0 is the
 *  shape the daemon answers with once everything has been removed. */
function storageReport(scale = 1) {
  return {
    home: '/home/u/.claude/cc-harness',
    scannedAt: Date.now(),
    groups: [
      {
        id: 'sessions',
        label: 'Finished sessions',
        detail: 'Recorded history for sessions the harness no longer lists.',
        count: 12 * scale,
        bytes: 4_000_000 * scale,
      },
      {
        id: 'partial-writes',
        label: 'Interrupted writes',
        detail: 'Half-written state.',
        count: 2 * scale,
        bytes: 2048 * scale,
      },
      { id: 'log', label: 'Daemon log', detail: 'The older part of the log.', count: 1 * scale, bytes: 1024 * scale },
      { id: 'lock', label: 'Stale lock file', detail: 'A dead address.', count: 0, bytes: 0 },
    ],
    totalBytes: 4_003_072 * scale,
  };
}

/** Daemon pids handed back by `/health`, in order; the last one sticks, the
 *  way a real daemon's pid does once the handover has settled. */
let pids: number[];
const nextPid = (): number => (pids.length > 1 ? pids.shift()! : (pids[0] ?? 0));

async function boot(sessions?: () => SessionSummary[]): Promise<void> {
  const list = sessions ?? SESSIONS;
  pids = [100, 100, 200];
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: list(), version: 'test' };
    if (route === '/api/storage') return { report: storageReport() };
    if (route === '/api/storage/clean') {
      return {
        result: { dryRun: false, groups: [], removed: 5, freedBytes: 3072, failed: [] },
        report: storageReport(0),
      };
    }
    if (route === '/api/daemon/restart') return { restarting: true };
    if (route === '/health') return { ok: true, version: 'test', pid: nextPid() };
    if (route.startsWith('/api/session/')) return { session: makeSession() };
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
    toasts: [],
    pinned: [],
    collapsedProjects: [],
    statusFilter: null,
    collapsedSidebar: false,
    storage: null,
    storageBusy: false,
    restarting: false,
  });
});

after(() => cleanup());

/* ------------------------------------------------------------------ */

test('sessions are grouped by the project they run in', async () => {
  await boot();
  assert.deepEqual(groupNames(), ['repo', 'other'], 'newest project first');
  const counts = [...document.querySelectorAll('.session-group-count')].map((el) => el.textContent);
  assert.deepEqual(counts, ['1', '2']);
  assert.deepEqual(rowNames(), ['s1 title', 's2 title', 's3 title']);
});

test('the rail holds its order when a session takes a turn', async () => {
  // Ordering on activity reshuffled the rail under the user's cursor: whichever
  // session last spoke jumped to the top. Creation order does not move.
  const now = Date.now();
  await boot();
  assert.deepEqual(groupNames(), ['repo', 'other']);
  assert.deepEqual(rowNames(), ['s1 title', 's2 title', 's3 title']);

  // s3 — the oldest session, in the second project — becomes the busiest one.
  await act(async () => {
    store.set({
      sessions: [
        summary('s1', 'repo', now),
        summary('s2', 'other', now - 1000),
        summary('s3', 'other', now - 2000, now + 5000),
      ],
    });
  });

  assert.deepEqual(groupNames(), ['repo', 'other'], 'activity does not reorder the projects');
  assert.deepEqual(rowNames(), ['s1 title', 's2 title', 's3 title'], 'nor the rows within one');
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

test('deleting a session forgets the pin and the folds hanging off it', async () => {
  await boot();
  // Flushed before the click: pinning re-parents the row into the Pinned
  // group, which remounts it and would drop the confirm mid-test.
  await act(async () => {
    store.set({ pinned: ['s2'], collapsedTasks: new Map([['s1', ['t1']], ['s2', ['t1']]]) });
  });

  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByTitle('Delete session'));
  });
  await act(async () => {
    fireEvent.click(within(rowFor('s2 title')).getByText('Delete'));
  });

  // Nothing else will ever clean it up: the session id is gone for good.
  assert.deepEqual(store.getState().pinned, []);
  assert.deepEqual([...store.getState().collapsedTasks.keys()], ['s1'], "another session's stay");
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

test('a row shows the plan, its progress, and what Claude is on', async () => {
  const now = Date.now();
  await boot(() => [
    {
      ...summary('s1', 'repo', now),
      planTitle: 'Cache rewrite',
      tasks: { total: 5, done: 2, inProgress: 1, blocked: 0 },
      current: 'Read-through wrapper',
      unreadByClaude: 3,
    },
  ]);
  const row = rowFor('Cache rewrite');
  assert.ok(row, 'the plan title names the row');
  assert.match(row.textContent ?? '', /now: Read-through wrapper/);
  assert.match(row.textContent ?? '', /2\/5 tasks/);
  assert.match(row.textContent ?? '', /unread/);
});

test('every row shows its plan\'s status in one of four words — Planning too — and the list filters by it (#66)', async () => {
  const now = Date.now();
  await boot(() => [
    { ...summary('s1', 'repo', now), planTitle: 'Designing' },
    { ...summary('s2', 'repo', now - 1000), planTitle: 'Tasking', phase: 'tasking' },
    { ...summary('s3', 'repo', now - 2000), planTitle: 'Building', phase: 'building', planStatus: 'in_progress', current: 'Wire it in' },
    { ...summary('s4', 'other', now - 3000), planTitle: 'Your review', phase: 'building', planStatus: 'review', awaitingReview: 1 },
    { ...summary('s5', 'other', now - 4000), planTitle: 'Finishing', phase: 'finalizing', planStatus: 'review' },
    { ...summary('s6', 'other', now - 5000), planTitle: 'Exported', phase: 'handed-off', planStatus: 'done' },
  ]);
  const pill = (name: string) => rowFor(name).querySelector('.status-pill');
  assert.equal(pill('Designing')?.textContent, 'Planning', 'a plan still being designed shows its status too');
  assert.equal(pill('Tasking')?.textContent, 'Planning');
  assert.match(pill('Tasking')?.getAttribute('title') ?? '', /design is confirmed/);
  assert.equal(pill('Building')?.textContent, 'In progress');
  assert.match(pill('Building')?.getAttribute('title') ?? '', /now Wire it in/);
  assert.equal(pill('Your review')?.textContent, 'Review');
  assert.match(pill('Your review')?.getAttribute('title') ?? '', /1 task waits on your review/);
  assert.equal(pill('Finishing')?.textContent, 'Review');
  assert.equal(pill('Exported')?.textContent, 'Done');
  assert.match(pill('Exported')?.getAttribute('title') ?? '', /exported/);

  const filter = screen.getByRole('group', { name: 'Show plans by status' });
  const buttons = within(filter).getAllByRole('button').map((b) => b.textContent);
  assert.deepEqual(buttons, ['All 6', 'Planning 2', 'In progress 1', 'Review 2', 'Done 1']);
  await act(async () => {
    fireEvent.click(within(filter).getByRole('button', { name: /^Review/ }));
  });
  assert.deepEqual(rowNames(), ['Your review', 'Finishing']);
  assert.equal(within(filter).getByRole('button', { name: /^Review/ }).getAttribute('aria-pressed'), 'true');
  assert.match(window.localStorage.getItem('cc-harness:prefs') ?? '', /"statusFilter":"review"/, 'remembered');
  // Pressed again, it lets go.
  await act(async () => {
    fireEvent.click(within(filter).getByRole('button', { name: /^Review/ }));
  });
  assert.equal(rowNames().length, 6);
  await act(async () => {
    fireEvent.click(within(filter).getByRole('button', { name: /^Done/ }));
  });
  assert.deepEqual(rowNames(), ['Exported']);
  await act(async () => {
    fireEvent.click(within(filter).getByRole('button', { name: /^All/ }));
  });
  assert.equal(rowNames().length, 6);
});

test('a status no plan has says so, with a way back to all of them (#66)', async () => {
  await boot(() => [summary('s1', 'repo', Date.now())]);
  await act(async () => {
    fireEvent.click(within(screen.getByRole('group', { name: 'Show plans by status' })).getByRole('button', { name: /^Done/ }));
  });
  assert.deepEqual(rowNames(), []);
  const empty = document.querySelector('.sidebar-empty');
  assert.match(empty?.textContent ?? '', /No plan is done\./);
  await act(async () => {
    fireEvent.click(within(empty as HTMLElement).getByRole('button', { name: 'Show all' }));
  });
  assert.deepEqual(rowNames(), ['s1 title']);
});

test('only sessions that used Coplan are listed, and the first of them opens', async () => {
  // Every session with the plugin registers. One that never asked for a plan
  // is someone's other chat, newest or not.
  const now = Date.now();
  await boot(() => [
    { ...summary('chat', 'repo', now + 1000), engaged: false },
    summary('s1', 'repo', now),
    { ...summary('s2', 'other', now - 1000), engaged: false, waiting: { kind: 'input' as const, text: 'Go?', since: now } },
    summary('s3', 'other', now - 2000),
  ]);
  assert.deepEqual(rowNames(), ['s1 title', 's3 title']);
  assert.deepEqual(groupNames(), ['repo', 'other'], 'not even a waiting one is lifted in');
  assert.equal(store.getState().sessionId, 's1', 'the page opens on a listed session');

  await act(async () => {
    fireEvent.click(screen.getByTitle('Collapse sidebar'));
  });
  assert.equal(document.querySelectorAll('.rail-item').length, 2, 'the folded rail holds the same sessions');
});

test('the session on screen is listed, even before it used Coplan', async () => {
  // Opened by its link (`/coplan-open`): the rail must not lose where you are.
  window.location.hash = '#/session/chat';
  try {
    const now = Date.now();
    await boot(() => [summary('s1', 'repo', now), { ...summary('chat', 'repo', now - 1000), engaged: false }]);
    assert.equal(store.getState().sessionId, 'chat');
    assert.deepEqual(rowNames(), ['s1 title', 'chat title']);
  } finally {
    window.location.hash = '';
  }
});

test('with no plans, the rail says how to start one', async () => {
  await boot(() => [{ ...summary('chat', 'repo', Date.now()), engaged: false }]);
  assert.deepEqual(rowNames(), []);
  assert.equal(store.getState().sessionId, null);
  assert.match(document.querySelector('.sidebar-empty')?.textContent ?? '', /\/coplan/);
});

test("a row leaves out the folder name its group already shows, but keeps a session's own name", async () => {
  const now = Date.now();
  await boot(() => [
    { ...summary('s1', 'repo', now), title: 'repo', planTitle: 'Cache rewrite' },
    { ...summary('s2', 'repo', now - 1000), title: 'Cache spike', planTitle: 'Cache rewrite v2' },
  ]);
  assert.equal(rowFor('Cache rewrite').querySelector('.session-stage'), null);
  assert.equal(rowFor('Cache rewrite v2').querySelector('.session-stage')?.textContent, 'Cache spike');
  // The branch is cut short on the row, so its full name is in the tooltip.
  assert.match(rowFor('Cache rewrite').querySelector('.session-open')?.getAttribute('title') ?? '', /on main/);
});

test('a session waiting on the user is lifted to the top, with a way into Claude', async () => {
  const now = Date.now();
  const link = { app: 'claude://claude.ai/code/session_1', web: 'https://claude.ai/code/session_1', via: 'cloud' as const };
  await boot(() => [
    summary('s1', 'repo', now),
    { ...summary('s3', 'other', now - 2000), waiting: { kind: 'question' as const, text: 'Which TTL?', since: now }, link },
  ]);
  assert.deepEqual(groupNames(), ['Waiting on you', 'repo']);
  const row = rowFor('s3 title');
  assert.match(row.textContent ?? '', /Which TTL\?/);
  assert.equal(within(row).getByText('Answer in Claude').getAttribute('href'), link.app);
});

test('collapsing the sidebar folds it to a rail of initials', async () => {
  const now = Date.now();
  await boot(() => [
    { ...summary('s1', 'repo', now), planTitle: 'Cache rewrite' },
    { ...summary('s2', 'other', now - 1000), waiting: { kind: 'input' as const, text: 'Go?', since: now } },
  ]);
  await act(async () => {
    fireEvent.click(screen.getByTitle('Collapse sidebar'));
  });
  assert.equal(document.querySelector('.session-list'), null, 'the full list is gone');
  const items = [...document.querySelectorAll('.rail-item')];
  assert.deepEqual(items.map((i) => i.textContent), ['ST', 'CR'], 'waiting first, by initials');
  assert.ok(items[0]!.classList.contains('is-waiting'));
  await act(async () => {
    fireEvent.click(items[0]!);
  });
  assert.equal(store.getState().sessionId, 's2', 'a rail item still opens its session');
});

test('a session can be renamed from the rail', async () => {
  await boot();
  posts.length = 0;

  await act(async () => {
    fireEvent.click(within(rowFor('s1 title')).getByTitle('Rename this session'));
  });
  const field = document.querySelector('.session-rename') as HTMLInputElement;
  assert.ok(field, 'the row becomes an input');
  assert.equal(document.activeElement, field, 'with the cursor in it');
  // The field takes the whole row: no buttons sit over its end.
  assert.equal(field.closest('.session-row')?.querySelector('.session-actions'), null);

  await act(async () => {
    fireEvent.change(field, { target: { value: 'Cache rewrite' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });

  const call = posts.find((p) => p.route.includes('/title'));
  assert.ok(call, 'the new name is saved');
  assert.equal(call!.body['title'], 'Cache rewrite');
  // Shown straight away rather than after the round trip.
  assert.ok(rowNames().some((n) => n.includes('Cache rewrite')));
});

test('abandoning a rename leaves the name alone', async () => {
  await boot();
  posts.length = 0;

  await act(async () => {
    fireEvent.click(within(rowFor('s1 title')).getByTitle('Rename this session'));
  });
  const field = document.querySelector('.session-rename') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(field, { target: { value: 'Discard me' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Escape' });
  });

  assert.equal(posts.find((p) => p.route.includes('/title')), undefined, 'nothing was saved');
  assert.ok(rowFor('s1 title').querySelector('.session-actions'), 'the row actions are back');
  assert.ok(rowNames().some((n) => n.includes('s1 title')), 'the original name is still there');
});

/* ------------------------------------------------------------------ *
 * Global actions
 * ------------------------------------------------------------------ */

const openCleanup = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTitle('Clean up stale Coplan files'));
  });
};

test('the cleanup panel lists only what is actually holding space', async () => {
  await boot();
  await openCleanup();

  const labels = [...document.querySelectorAll('.global-group-name')].map((el) => el.textContent);
  assert.deepEqual(
    labels,
    ['Finished sessions', 'Interrupted writes', 'Daemon log'],
    'empty groups are decisions the user does not have to make',
  );
});

test('recorded history is the one group not ticked by default', async () => {
  // Everything else the panel offers is unambiguously garbage. Session
  // history is the only thing whose removal loses something a user might
  // want back, so removing it has to be a deliberate tick.
  await boot();
  await openCleanup();

  const boxes = [...document.querySelectorAll('.global-group input')] as HTMLInputElement[];
  assert.deepEqual(
    boxes.map((b) => b.checked),
    [false, true, true],
  );
  // The button offers the total of what is ticked, not of everything found.
  assert.match(screen.getByText(/^Clean up/).textContent ?? '', /3 KB/);
});

test('only the ticked groups are sent to be removed', async () => {
  await boot();
  await openCleanup();
  posts.length = 0;

  await act(async () => {
    fireEvent.click(screen.getByText(/^Clean up/));
  });

  const call = posts.find((p) => p.route === '/api/storage/clean');
  assert.ok(call, 'the clean request was sent');
  assert.deepEqual(call!.body['groups'], ['partial-writes', 'log']);
  assert.ok(
    store.getState().toasts.some((t) => /Reclaimed/.test(t.text)),
    'the user is told how much came back',
  );
  // The daemon answers with a freshly scanned report, and the panel redraws
  // from that rather than from an optimistic subtraction.
  assert.equal(document.querySelector('.global-empty')?.textContent, 'Nothing to clean up.');
});

test('ticking history in adds it to the request', async () => {
  await boot();
  await openCleanup();
  posts.length = 0;

  const first = document.querySelector('.global-group input') as HTMLInputElement;
  await act(async () => {
    fireEvent.click(first);
  });
  await act(async () => {
    fireEvent.click(screen.getByText(/^Clean up/));
  });

  const call = posts.find((p) => p.route === '/api/storage/clean');
  assert.deepEqual(call!.body['groups'], ['sessions', 'partial-writes', 'log']);
});

test('a restart is confirmed first', async () => {
  await boot();
  const reloaded = stubReload();

  await act(async () => {
    fireEvent.click(screen.getByTitle('Restart the daemon to pick up a new build'));
  });
  assert.ok(document.querySelector('.global-confirm'), 'the click asks before it acts');
  assert.equal(posts.find((p) => p.route === '/api/daemon/restart'), undefined, 'and sends nothing yet');

  await act(async () => {
    fireEvent.click(screen.getByText('Restart'));
  });
  assert.ok(posts.find((p) => p.route === '/api/daemon/restart'), 'confirming sends the request');

  // The page reloads only once a *different* daemon answers: reloading against
  // the outgoing one would race the handover onto a closed socket.
  await waitFor(() => assert.equal(reloaded.count, 1));
});

test('a restart that never lands says so instead of hanging', async () => {
  await boot();
  const reloaded = stubReload();
  pids = [100]; // `/health` keeps answering with the outgoing pid

  await act(async () => {
    await store.restartDaemon(600);
  });

  assert.equal(reloaded.count, 0, 'nothing is reloaded onto a daemon that is not there');
  assert.equal(store.getState().restarting, false, 'and the UI is usable again');
  assert.ok(store.getState().toasts.some((t) => /did not come back/.test(t.text)));
});

/** Count reloads instead of performing one, which jsdom cannot do. */
function stubReload(): { count: number } {
  const calls = { count: 0 };
  store.reloadPage = () => {
    calls.count++;
  };
  return calls;
}
