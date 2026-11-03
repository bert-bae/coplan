import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { Plan, PlanInput, SessionState } from '../shared/types.ts';

/**
 * The planning workspace in a browser: every edit becomes an op sent to the
 * daemon, and nothing on the page talks to Claude or answers it — questions
 * are shown, and linked back to the session.
 */

setupDom();

const { render, fireEvent, within, cleanup, act, screen, waitFor } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');
const { publishPlan, applyOps } = await import('../shared/plan.ts');

const INPUT: PlanInput = {
  title: 'Add a cache',
  summary: 'Put a cache in front of the database.',
  sections: [{ title: 'Context', body: 'Reads are **slow**.' }],
  tasks: [
    { id: 'storage', title: 'Storage layer', subtasks: [{ title: 'Cache client', status: 'done' }, { title: 'Invalidation' }] },
    { title: 'Wire into API', status: 'in_progress' },
  ],
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service' },
        { id: 'db', label: 'Postgres', kind: 'datastore', taskIds: ['storage'], notes: 'Primary store.' },
      ],
      edges: [{ source: 'api', target: 'db', label: 'SQL' }],
    },
  ],
};

function makePlan(unread = false): Plan {
  const plan = publishPlan(null, INPUT, Date.now()).plan;
  return unread ? applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'hm' }], 'user').plan : plan;
}

function makeSession(plan: Plan | null = makePlan(), extra: Partial<SessionState> = {}): SessionState {
  const now = Date.now();
  return {
    sessionId: 's1',
    cwd: '/repo',
    repoRoot: '/repo',
    branch: 'main',
    title: 'repo',
    status: 'idle',
    waiting: null,
    surface: 'unknown',
    link: null,
    createdAt: now,
    updatedAt: now,
    plan,
    ...extra,
  };
}

const LINK = { app: 'claude://claude.ai/code/session_1', web: 'https://claude.ai/code/session_1', via: 'cloud' as const };

let posts: { route: string; body: Record<string, unknown> }[];

async function boot(session: SessionState = makeSession()): Promise<void> {
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    if (route.endsWith('/plan/ops')) return { plan: store.getState().session?.plan, changes: [] };
    if (route.endsWith('/plan/text')) return '# Add a cache\n\nas Claude reads it';
    if (route.startsWith('/api/session/')) return { session };
    return { ok: true };
  }));
  render(<App />);
  await act(async () => {
    await store.init();
  });
}

const opsSent = () => posts.filter((p) => p.route.endsWith('/plan/ops')).flatMap((p) => p.body['ops'] as Record<string, unknown>[]);

const openTab = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
  });
};

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store.set({
    sessions: [],
    sessionId: null,
    session: null,
    tab: 'diagrams',
    diagramId: null,
    taskMode: 'outline',
    hideDone: false,
    collapsedTasks: [],
    collapsedSidebar: false,
    toasts: [],
    focusTarget: null,
  });
});

after(() => cleanup());

/* ------------------------------------------------------------------ */

test('three views, architecture first, and no way to answer Claude here', async () => {
  await boot();
  const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d.*$/, ''));
  assert.deepEqual(tabs, ['Architecture', 'Tasks', 'Overview']);
  assert.equal(screen.getByRole('tab', { selected: true }).textContent?.startsWith('Architecture'), true);
  assert.equal(screen.queryByText(/questions/i), null);
  assert.equal(screen.queryByText(/activity/i), null);
});

test('with no plan yet, the page says how to get one', async () => {
  await boot(makeSession(null));
  assert.ok(screen.getByText('No plan yet'));
  await act(async () => {
    fireEvent.click(screen.getByText('Start a plan by hand'));
  });
  assert.equal(opsSent()[0]!['op'], 'set_meta');
});

/* ------------------------------------------------------- back to Claude */

test('when Claude asks something, the page shows it and links to the session', async () => {
  await boot(
    makeSession(makePlan(), {
      link: LINK,
      waiting: {
        kind: 'question',
        text: 'Which TTL?',
        questions: [{ header: 'TTL', question: 'Which TTL?', options: ['1 minute', '10 minutes'] }],
        since: Date.now(),
      },
    }),
  );
  const banner = screen.getByRole('status', { name: 'Claude is waiting on you' });
  assert.match(banner.textContent ?? '', /Claude is asking you/);
  assert.match(banner.textContent ?? '', /Which TTL\?/);
  assert.match(banner.textContent ?? '', /1 minute · 10 minutes/);
  assert.equal(within(banner).getByText('Answer in Claude').getAttribute('href'), LINK.app, 'opens the desktop app');
  assert.equal(within(banner).getByText('web').getAttribute('href'), LINK.web);
  assert.equal(banner.querySelector('input, textarea, select'), null, 'nothing to answer with here');
  assert.match(document.title, /Claude is waiting/);
});

test('without a link, the banner says where to answer and how to get one', async () => {
  await boot(makeSession(makePlan(), { surface: 'cli', waiting: { kind: 'permission', text: 'Allow Bash?', since: Date.now() } }));
  const banner = screen.getByRole('status', { name: 'Claude is waiting on you' });
  assert.match(banner.textContent ?? '', /in your terminal/);
  assert.match(banner.textContent ?? '', /\/remote-control/);
  assert.ok(within(banner).getByText('Copy message for Claude'));
});

test('the header opens the session in Claude, and says when Claude is behind', async () => {
  await boot(makeSession(makePlan(true), { link: LINK }));
  assert.match(document.querySelector('.handoff')?.textContent ?? '', /1 change Claude hasn't read/);
  assert.equal(screen.getByText('Open in Claude').getAttribute('href'), LINK.app);
});

test('"As Claude sees it" shows the text harness_plan_read returns', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByText('As Claude sees it'));
  });
  await waitFor(() => assert.match(document.querySelector('.claude-text')?.textContent ?? '', /as Claude reads it/));
});

/* --------------------------------------------------------- architecture */

test('the diagram fills the view, with the diagram itself in the panel', async () => {
  await boot();
  assert.ok(document.querySelector('.arch-body .flow .react-flow'), 'the canvas');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  assert.match(panel.textContent ?? '', /Diagram/);
  assert.match(panel.textContent ?? '', /2 boxes, 1 arrows, 1 tracking tasks/);
  await waitFor(() => {
    const labels = [...document.querySelectorAll('.flow-node-label')].map((n) => n.textContent);
    assert.deepEqual(labels.sort(), ['API', 'Postgres']);
  });
});

test('a box shows the progress of the tasks that build it', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.flow-node.kind-datastore .flow-node-progress')));
  assert.match(document.querySelector('.flow-node.kind-datastore .flow-node-progress')?.textContent ?? '', /1\/2/);
});

const selectBox = async (label: string) => {
  const node = [...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent?.includes(label)) as HTMLElement;
  await act(async () => {
    fireEvent.click(node);
  });
};

test('selecting a box opens its details in the side panel', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  await waitFor(() => assert.ok(within(panel).getByLabelText('Box label')));
  assert.equal((within(panel).getByLabelText('Box label') as HTMLInputElement).value, 'Postgres');
  assert.match(panel.textContent ?? '', /Primary store\./);
  assert.match(panel.textContent ?? '', /Built by/);
  assert.match(panel.textContent ?? '', /Storage layer/);
  assert.match(panel.textContent ?? '', /← API/);
});

test('editing a box in the panel saves the graph', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  await waitFor(() => assert.ok(within(panel).getByLabelText('Link a task to API')));
  await act(async () => {
    fireEvent.change(within(panel).getByLabelText('Link a task to API'), { target: { value: 't3' } });
  });
  const op = opsSent().at(-1)!;
  assert.equal(op['op'], 'upsert_diagram');
  const api = (op['nodes'] as { id: string; taskIds?: string[] }[]).find((n) => n.id === 'api')!;
  assert.deepEqual(api.taskIds, ['t3']);
});

test('a new diagram starts from a template', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByText('+ New diagram'));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Components' }));
  });
  const op = opsSent()[0]!;
  assert.equal(op['op'], 'upsert_diagram');
  assert.equal((op['nodes'] as unknown[]).length, 3);
});

/* ---------------------------------------------------------------- tasks */

test('the outline shows the breakdown, and which part each task builds', async () => {
  await boot();
  await openTab('Tasks');
  const rows = [...document.querySelectorAll('.task-line')].map((r) => r.querySelector('.task-num')?.textContent + ' ' + r.querySelector('.task-title')?.textContent);
  assert.deepEqual(rows, ['1 Storage layer', '1.1 Cache client', '1.2 Invalidation', '2 Wire into API']);
  const part = screen.getByTitle(/Builds "Postgres"/);
  await act(async () => {
    fireEvent.click(part);
  });
  assert.equal(store.getState().tab, 'diagrams', 'the part opens on the canvas');
});

test('clicking a status dot moves the task along', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/^Invalidation: To do/));
  });
  assert.deepEqual(opsSent()[0], { op: 'upsert_task', id: 't2', status: 'in_progress' });
});

test('Alt+arrows reorganize the tree from the keyboard', async () => {
  await boot();
  await openTab('Tasks');
  const row = screen.getByRole('treeitem', { name: /^2 Wire into API/ });
  await act(async () => {
    fireEvent.keyDown(row, { key: 'ArrowRight', altKey: true });
  });
  assert.deepEqual(opsSent()[0], { op: 'move_task', id: 't3', parentId: 'storage', index: Number.MAX_SAFE_INTEGER });

  const child = screen.getByRole('treeitem', { name: /^1\.2 Invalidation/ });
  await act(async () => {
    fireEvent.keyDown(child, { key: 'ArrowLeft', altKey: true });
  });
  assert.deepEqual(opsSent()[1], { op: 'move_task', id: 't2', parentId: null, index: 1 });
});

test('a subtask is added under its parent', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Add a subtask to Wire into API'));
  });
  const input = screen.getByLabelText('New subtask of Wire into API');
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Feature flag' } });
  });
  await act(async () => {
    fireEvent.submit(input.closest('form')!);
  });
  assert.deepEqual(opsSent()[0], { op: 'upsert_task', parentId: 't3', title: 'Feature flag' });
});

test('the board puts each leaf task in its status column', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByText('Board'));
  });
  const todo = screen.getByRole('region', { name: 'To do' });
  assert.deepEqual([...todo.querySelectorAll('.board-title')].map((t) => t.textContent), ['Invalidation']);
  const doing = screen.getByRole('region', { name: 'In progress' });
  assert.deepEqual([...doing.querySelectorAll('.board-title')].map((t) => t.textContent), ['Wire into API']);
});

/* ------------------------------------------------------------- overview */

test('the overview says what Claude is on', async () => {
  await boot();
  await openTab('Overview');
  const tiles = screen.getByRole('list', { name: 'Plan at a glance' });
  assert.match(tiles.textContent ?? '', /Claude is on\s*Wire into API/);
  assert.match(tiles.textContent ?? '', /1\/3/);
});

test('a section is edited in place and saved as an op', async () => {
  await boot();
  await openTab('Overview');
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Edit section "Context"'));
  });
  const area = screen.getByLabelText('section "Context"') as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(area, { target: { value: 'Reads take 400ms.' } });
  });
  await act(async () => {
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
  });
  assert.deepEqual(opsSent()[0], { op: 'upsert_section', id: 's1', body: 'Reads take 400ms.' });
});

test('a snapshot from Claude replaces the plan and says so', async () => {
  await boot();
  const next = makePlan();
  next.revision = 2;
  next.title = 'Add a cache (v2)';
  await act(async () => {
    store.apply({ type: 'snapshot', session: makeSession(next) });
  });
  assert.ok(screen.getByText('Add a cache (v2)'));
  assert.ok(store.getState().toasts.some((t) => /revision 2/.test(t.text)));
});

/* ---------------------------------------------------- layout and access */

test('the header hides and shows the session list', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Hide sessions'));
  });
  assert.equal(store.getState().collapsedSidebar, true);
  assert.ok(document.querySelector('.app')?.classList.contains('is-sidebar-collapsed'));
  await act(async () => {
    fireEvent.keyDown(document.body, { key: '[' });
  });
  assert.equal(store.getState().collapsedSidebar, false, '[ toggles it back');
});

test('the tab strip is one tab stop, and arrow keys move along it', async () => {
  await boot();
  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1]);
  await act(async () => {
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
  });
  assert.equal(store.getState().tab, 'overview', 'wraps at the ends');
});

test('choosing a theme sets an explicit attribute', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
  });
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('icon-only controls carry a name', async () => {
  await boot();
  await openTab('Tasks');
  for (const button of document.querySelectorAll('button')) {
    const name = button.getAttribute('aria-label') ?? button.textContent?.trim();
    assert.ok(name && !/^[↑↓←→＋×⌄⌃✎☰]$/.test(name), `unnamed button: ${button.outerHTML.slice(0, 120)}`);
  }
});
