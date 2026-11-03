import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { Plan, PlanInput, SessionState } from '../shared/types.ts';

/**
 * The planning workspace in a browser: every edit becomes an op sent to the
 * daemon, and nothing on the page talks to Claude.
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
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service' },
        { id: 'db', label: 'Postgres', kind: 'datastore' },
      ],
      edges: [{ source: 'api', target: 'db', label: 'SQL' }],
    },
  ],
  tasks: [
    { title: 'Storage layer', subtasks: [{ title: 'Cache client' }, { title: 'Invalidation' }] },
    { title: 'Wire into API' },
  ],
  questions: [
    { question: 'Which cache?', header: 'Backend', options: [{ label: 'Redis', description: 'Shared.' }, { label: 'In-memory' }] },
  ],
};

function makePlan(unread = false): Plan {
  const plan = publishPlan(null, INPUT, Date.now()).plan;
  return unread ? applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'hm' }], 'user').plan : plan;
}

function makeSession(plan: Plan | null = makePlan()): SessionState {
  const now = Date.now();
  return { sessionId: 's1', cwd: '/repo', repoRoot: '/repo', branch: 'main', title: 'repo', status: 'idle', createdAt: now, updatedAt: now, plan };
}

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
  store.set({ sessions: [], sessionId: null, session: null, tab: 'overview', taskMode: 'outline', hideDone: false, collapsedTasks: [], toasts: [], focusTarget: null });
});

after(() => cleanup());

/* ------------------------------------------------------------------ */

test('the workspace is five planning views, with no way to message Claude', async () => {
  await boot();
  const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d.*$/, ''));
  assert.deepEqual(tabs, ['Overview', 'Diagrams', 'Tasks', 'Questions', 'Activity']);
  assert.equal(document.querySelector('[aria-label*="Message" i]'), null);
  assert.equal(screen.queryByText(/send now/i), null);
  assert.equal(screen.queryByText(/approve/i), null);
});

test('with no plan yet, the page says how to get one', async () => {
  await boot(makeSession(null));
  assert.ok(screen.getByText('No plan yet'));
  await act(async () => {
    fireEvent.click(screen.getByText('Start a plan by hand'));
  });
  assert.equal(opsSent()[0]!['op'], 'set_meta');
});

test('the header says when Claude is behind, and offers the message to paste', async () => {
  await boot(makeSession(makePlan(true)));
  assert.match(document.querySelector('.handoff')?.textContent ?? '', /1 change Claude hasn't read/);
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  await act(async () => {
    fireEvent.click(screen.getByText('Copy message for Claude'));
  });
  assert.match(copied, /harness_plan_read/);
});

test('when Claude is up to date the header says so', async () => {
  await boot();
  assert.match(document.querySelector('.handoff')?.textContent ?? '', /Claude is up to date/);
});

test('"As Claude sees it" shows the text harness_plan_read returns', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByText('As Claude sees it'));
  });
  await waitFor(() => assert.match(document.querySelector('.claude-text')?.textContent ?? '', /as Claude reads it/));
});

/* ------------------------------------------------------------- overview */

test('a section is edited in place and saved as an op', async () => {
  await boot();
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

test('a comment is left on a section', async () => {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Comment on Context'));
  });
  const box = screen.getByLabelText('New comment on Context');
  await act(async () => {
    fireEvent.change(box, { target: { value: 'Add numbers' } });
  });
  await act(async () => {
    fireEvent.click(within(box.closest('.thread-composer') as HTMLElement).getByText('Comment'));
  });
  assert.deepEqual(opsSent()[0], { op: 'comment', target: { kind: 'section', id: 's1' }, text: 'Add numbers' });
});

/* ---------------------------------------------------------------- tasks */

test('the outline shows the breakdown with outline numbers', async () => {
  await boot();
  await openTab('Tasks');
  const rows = [...document.querySelectorAll('.task-line')].map((r) => r.querySelector('.task-num')?.textContent + ' ' + r.querySelector('.task-title')?.textContent);
  assert.deepEqual(rows, ['1 Storage layer', '1.1 Cache client', '1.2 Invalidation', '2 Wire into API']);
  assert.match(document.querySelector('.toolbar-progress')?.textContent ?? '', /0\/3 done/);
});

test('clicking a status dot moves the task along', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/^Cache client: To do/));
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
  assert.deepEqual(opsSent()[0], { op: 'move_task', id: 't4', parentId: 't1', index: Number.MAX_SAFE_INTEGER });

  const child = screen.getByRole('treeitem', { name: /^1\.2 Invalidation/ });
  await act(async () => {
    fireEvent.keyDown(child, { key: 'ArrowLeft', altKey: true });
  });
  assert.deepEqual(opsSent()[1], { op: 'move_task', id: 't3', parentId: null, index: 1 });

  await act(async () => {
    fireEvent.keyDown(child, { key: 'ArrowUp', altKey: true });
  });
  assert.deepEqual(opsSent()[2], { op: 'move_task', id: 't3', parentId: 't1', index: 0 });
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
  assert.deepEqual(opsSent()[0], { op: 'upsert_task', parentId: 't4', title: 'Feature flag' });
});

test('folding a parent hides its subtasks, and the fold is remembered', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Hide subtasks of Storage layer'));
  });
  assert.equal(document.querySelectorAll('.task-line').length, 2);
  assert.match(window.localStorage.getItem('cc-harness:prefs') ?? '', /"collapsedTasks":\["t1"\]/);
});

test('the board puts each leaf task in its status column', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByText('Board'));
  });
  const todo = screen.getByRole('region', { name: 'To do' });
  const titles = [...todo.querySelectorAll('.board-title')].map((t) => t.textContent);
  assert.deepEqual(titles, ['Cache client', 'Invalidation', 'Wire into API'], 'the parent heading is not a card');
  assert.match(todo.querySelector('.board-path')?.textContent ?? '', /Storage layer/);
  await act(async () => {
    fireEvent.change(within(todo).getByLabelText('Status of Invalidation'), { target: { value: 'blocked' } });
  });
  assert.deepEqual(opsSent()[0], { op: 'upsert_task', id: 't3', status: 'blocked' });
});

/* ------------------------------------------------------------ questions */

test('answering a question saves it to the plan', async () => {
  await boot();
  await openTab('Questions');
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Redis/ }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Answer to: Which cache?'), { target: { value: 'we run it already' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Save answer'));
  });
  assert.deepEqual(opsSent()[0], { op: 'answer', id: 'q1', selected: ['Redis'], text: 'we run it already' });
});

test('the user can ask Claude a question', async () => {
  await boot();
  await openTab('Questions');
  await act(async () => {
    fireEvent.click(screen.getByText('+ Ask Claude a question'));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Question for Claude'), { target: { value: 'Is Redis HA here?' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Add question'));
  });
  assert.deepEqual(opsSent()[0], { op: 'upsert_question', question: 'Is Redis HA here?' });
});

/* ------------------------------------------------------------- diagrams */

test('a diagram renders as a React Flow canvas of its boxes', async () => {
  await boot();
  await openTab('Diagrams');
  assert.ok(document.querySelector('.react-flow'), 'the canvas is mounted');
  await waitFor(() => {
    const labels = [...document.querySelectorAll('.flow-node-label')].map((n) => n.textContent);
    assert.deepEqual(labels.sort(), ['API', 'Postgres']);
  });
  assert.ok(document.querySelector('.flow-node.kind-datastore'), 'the kind sets the shape');
});

test('a new diagram starts from a template', async () => {
  await boot();
  await openTab('Diagrams');
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

/* ------------------------------------------------------------- activity */

test('the activity log marks what Claude has not read', async () => {
  await boot(makeSession(makePlan(true)));
  await openTab('Activity');
  const rows = [...document.querySelectorAll('.activity-row, .activity-marker')].map((r) => r.className);
  assert.ok(rows[0]!.includes('is-unread'), 'the newest change is unread');
  assert.ok(rows[1]!.includes('activity-marker'), 'then the line Claude has read up to');
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

/* -------------------------------------------------------- accessibility */

test('the tab strip is one tab stop, and arrow keys move along it', async () => {
  await boot();
  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1, -1, -1]);
  const panel = document.getElementById(tabs[0]!.getAttribute('aria-controls')!);
  assert.equal(panel?.getAttribute('role'), 'tabpanel');
  await act(async () => {
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
  });
  assert.equal(store.getState().tab, 'activity', 'wraps at the ends');
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
    assert.ok(name && !/^[↑↓←→＋×⌄⌃✎]$/.test(name), `unnamed button: ${button.outerHTML.slice(0, 120)}`);
  }
});
