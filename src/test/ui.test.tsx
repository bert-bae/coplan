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
const { publishPlan, applyOps, submitPlan, markDelivered, reopenPlan, confirmDesign, queueRevision, markRevisionDelivered } = await import('../shared/plan.ts');

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
    agent: 'claude',
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

async function boot(session: SessionState = makeSession(), extra?: (route: string, init?: RequestInit) => unknown): Promise<void> {
  ({ posts } = stubFetch((route, init) => {
    const answer = extra?.(route, init);
    if (answer !== undefined) return answer;
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
    planCheck: {},
    hideDone: false,
    collapsedTasks: [],
    collapsedSidebar: false,
    toasts: [],
    focusTarget: null,
    proposalPreview: null,
    viewer: null,
    exportOpen: false,
    showBookkeeping: false,
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
  assert.match(document.querySelector('.handoff')?.textContent ?? '', /Claude hasn't read your changes/);
  assert.match(document.querySelector('.handoff-state')?.getAttribute('title') ?? '', /You changed comments/);
  assert.equal(screen.getByText('Open in Claude').getAttribute('href'), LINK.app);
});

/** The daemon's answers for the prompt viewer, made by the daemon's own renderers. */
async function viewerRoutes(session: SessionState): Promise<(route: string) => unknown> {
  const { planBlocks, renderPlan, designPrompt, buildPrompt } = await import('../daemon/render.ts');
  const { briefBlocks, renderBrief } = await import('../daemon/brief.ts');
  return (route: string) => {
    const plan = store.getState().session?.plan ?? session.plan!;
    if (route.endsWith('/plan/readback')) return { text: renderPlan(plan), blocks: planBlocks(plan), version: plan.version };
    const brief = /\/task\/([^/]+)\/brief$/.exec(route);
    if (brief) {
      const task = plan.tasks.find((t) => t.id === decodeURIComponent(brief[1]!))!;
      return { text: renderBrief(plan, task), blocks: briefBlocks(plan, task), task: { id: task.id, title: task.title }, version: plan.version };
    }
    if (route.endsWith('/plan/design/prompt')) {
      const { prompt, trimmed, blocks } = designPrompt(plan);
      return { prompt, trimmed, blocks, version: plan.version, budget: 9000, maxNote: 4000 };
    }
    if (route.endsWith('/plan/prompt')) {
      const { prompt, trimmed, blocks } = buildPrompt(plan, { target: 'session', settings: { review: 'subagent', parallel: 2, maxRounds: 3 } });
      return { prompt, trimmed, blocks, version: plan.version, budget: 9000, maxNote: 4000, settings: { review: 'subagent', parallel: 2, maxRounds: 3 } };
    }
    return undefined;
  };
}

test('"What Claude reads" shows the read-back block by block, each with its source, and the bookkeeping only when asked', async () => {
  const session = makeSession(makePlan(true));
  await boot(session, await viewerRoutes(session));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'What Claude reads' }));
  });
  const viewer = screen.getByRole('dialog', { name: 'What Claude reads' });
  assert.equal(within(viewer).getByRole('tab', { name: 'Read-back' }).getAttribute('aria-selected'), 'true');
  const text = () => within(viewer).getByTestId('viewer-text').textContent ?? '';
  await waitFor(() => assert.match(text(), /# Add a cache/));
  assert.match(text(), /Reads are \*\*slow\*\*\./, 'the content is there');
  // Revisions and reply hints are the agent's bookkeeping: hidden until asked for.
  assert.doesNotMatch(text(), /rev \d|reply with harness_plan_edit|_Statuses:/);
  const toggle = within(viewer).getByRole('checkbox', { name: /Agent bookkeeping/ });
  assert.equal((toggle as HTMLInputElement).checked, false);
  await act(async () => {
    fireEvent.click(toggle);
  });
  assert.match(text(), /rev \d/);
  assert.match(text(), /reply with harness_plan_edit/);
  assert.match(text(), /_Statuses:/);

  // Each part names its source: a section, a box, the config, Coplan itself.
  assert.ok(within(viewer).getByRole('button', { name: 'Section · Context' }));
  assert.ok(within(viewer).getAllByRole('button', { name: 'Box · Postgres' }).length);
  assert.ok(within(viewer).getAllByText('Coplan').length);
  // A field chip shows that item in the page.
  await act(async () => {
    fireEvent.click(within(viewer).getAllByRole('button', { name: 'Box · Postgres' })[0]!);
  });
  assert.equal(screen.queryByRole('dialog', { name: 'What Claude reads' }), null, 'the viewer closes to show it');
  assert.equal(store.getState().tab, 'diagrams');
  const diagram = session.plan!.diagrams[0]!.id;
  assert.equal(store.getState().diagramId, diagram);
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node.selected')?.textContent?.includes('Postgres'), 'the box is selected'));
});

test("from any task, one click shows its brief exactly as harness_task_brief gives it, with chips that go to what it quotes", async () => {
  const session = makeSession();
  const routes = await viewerRoutes(session);
  await boot(session, routes);
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Brief for Invalidation' }));
  });
  const viewer = screen.getByRole('dialog', { name: 'What Claude reads' });
  assert.equal(within(viewer).getByRole('tab', { name: 'Task brief' }).getAttribute('aria-selected'), 'true');
  const task = session.plan!.tasks.find((t) => t.title === 'Invalidation')!;
  assert.equal((within(viewer).getByRole('combobox', { name: 'Task' }) as HTMLSelectElement).value, task.id);
  const { renderBrief } = await import('../daemon/brief.ts');
  const tool = renderBrief(session.plan!, task);
  await waitFor(() => assert.match(within(viewer).getByTestId('viewer-text').textContent ?? '', /# Task t\d+: Invalidation/));
  // Copy gives the brief whole, exactly as the agent's tool returns it.
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  await act(async () => {
    fireEvent.click(within(viewer).getByRole('button', { name: 'Copy' }));
  });
  assert.equal(copied, tool);

  // Another task, from the picker.
  const wire = session.plan!.tasks.find((t) => t.title === 'Wire into API')!;
  await act(async () => {
    fireEvent.change(within(viewer).getByRole('combobox', { name: 'Task' }), { target: { value: wire.id } });
  });
  await waitFor(() => assert.match(within(viewer).getByTestId('viewer-text').textContent ?? '', /# Task t\d+: Wire into API/));
  // The objective's chip goes to the task in the outline.
  await act(async () => {
    fireEvent.click(within(viewer).getAllByRole('button', { name: /^Task t\d+ · Wire into API$/ })[0]!);
  });
  assert.equal(screen.queryByRole('dialog', { name: 'What Claude reads' }), null);
  assert.equal(store.getState().tab, 'tasks');
  await waitFor(() => assert.ok(document.getElementById(`task-${wire.id}`)?.classList.contains('is-flash')));
});

test('the next prompt is the one the next sign-off sends; what it leaves out to fit is struck through', async () => {
  const long = 'A long paragraph of detail that goes on and on about the work. '.repeat(20);
  let plan = makePlan();
  plan = applyOps(plan, [{ op: 'upsert_section', id: plan.sections[0]!.id, body: long.repeat(8) }], 'claude').plan;
  const session = makeSession(plan);
  await boot(session, await viewerRoutes(session));
  await act(async () => {
    store.openViewer({ tab: 'prompt' });
  });
  const viewer = screen.getByRole('dialog', { name: 'What Claude reads' });
  assert.match(viewer.textContent ?? '', /What Confirm design would send Claude now/);
  await waitFor(() => assert.match(within(viewer).getByTestId('viewer-text').textContent ?? '', /The design is confirmed for "Add a cache"/));
  const dropped = viewer.querySelectorAll('.pv-row.is-dropped');
  assert.ok(dropped.length > 0);
  assert.match(viewer.querySelector('.pv-left')?.textContent ?? '', /Left out to fit — the agent reads this with harness_plan_read/);
  assert.match(viewer.textContent ?? '', /Left out to fit: 1 section, the architecture \(1 diagram\)/);
  assert.ok([...dropped].some((r) => r.getAttribute('data-block') === `section:${plan.sections[0]!.id}`));
  // The settings and config chips say where the words come from.
  assert.ok(within(viewer).getAllByRole('link', { name: /\.coplan\/config\.json#/ }).length);
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
  await waitFor(() => assert.ok(document.querySelector('.flow-node.kind-datastore .flow-node-foot .progress')));
  // Found by its name: React Flow hides boxes jsdom cannot measure.
  const chip = document.querySelector<HTMLButtonElement>('button[aria-label^="Tasks for Postgres:"]')!;
  assert.equal(chip.textContent, '☐1/2');
  assert.equal(chip.getAttribute('aria-label'), 'Tasks for Postgres: 1 of 2 done', 'leaves of what it links: a parent counts as its subtasks');
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

/** The last op sent for the diagram, and one of its nodes. */
const lastGraph = () => {
  const op = opsSent().filter((o) => o['op'] === 'upsert_diagram').at(-1)!;
  return { nodes: op['nodes'] as Record<string, unknown>[], edges: op['edges'] as Record<string, unknown>[] };
};

test('short fields are inputs; the description is a textarea that saves when you leave it', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  assert.equal(within(panel).getByLabelText('Box label').tagName, 'INPUT');
  assert.equal(within(panel).getByLabelText('Box detail').tagName, 'INPUT');
  const area = within(panel).getByLabelText('Description of Postgres');
  assert.equal(area.tagName, 'TEXTAREA', 'a paragraph gets room to be one');
  await act(async () => {
    fireEvent.change(area, { target: { value: 'Holds every order.\nThe system of record.' } });
    fireEvent.blur(area);
  });
  const db = lastGraph().nodes.find((n) => n['id'] === 'db')!;
  assert.equal(db['description'], 'Holds every order.\nThe system of record.');
  assert.equal(db['notes'], 'Primary store.', 'the rest of the box is sent as it was');
});

test("hovering a box's info icon opens a summary of it", async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  // React Flow keeps boxes it has not measured hidden, and jsdom measures
  // nothing, so the button is found by its name rather than its role.
  const info = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button[aria-label="About Postgres"]');
    assert.ok(el);
    return el;
  });
  await act(async () => {
    fireEvent.mouseEnter(info);
  });
  await waitFor(() => assert.ok(document.querySelector('.flow-summary')));
  const text = document.querySelector('.flow-summary')!.textContent ?? '';
  assert.match(text, /Datastore/);
  assert.match(text, /No description yet/, 'and says how to add one');
  assert.match(text, /Decisions\s*Primary store\./);
  assert.match(text, /Built by 1\/2\s*Storage layer/, 'the tasks that build it, and how far along they are');
  assert.match(text, /← API · SQL/, 'and what it talks to');
  await act(async () => {
    fireEvent.keyDown(info, { key: 'Escape' });
  });
  await waitFor(() => assert.equal(document.querySelector('.flow-summary'), null));
});

test('the kind is picked from the shapes themselves', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  await act(async () => {
    fireEvent.click(within(panel).getByRole('radio', { name: 'Queue' }));
  });
  assert.equal(lastGraph().nodes.find((n) => n['id'] === 'api')!['kind'], 'queue');
});

test('boxes copy to the clipboard and paste back with fresh ids and everything on them', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  let clip = '';
  await act(async () => {
    fireEvent.copy(document.body, { clipboardData: { setData: (_: string, v: string) => (clip = v), getData: () => clip } });
  });
  assert.match(clip, /cc-harness\/diagram-selection/);
  await act(async () => {
    fireEvent.paste(document.body, { clipboardData: { getData: () => clip } });
  });
  const copy = lastGraph().nodes.find((n) => n['id'] === 'db-2');
  assert.ok(copy, 'pasted under a new id');
  assert.equal(copy['label'], 'Postgres');
  assert.equal(copy['notes'], 'Primary store.');
  assert.deepEqual(copy['taskIds'], ['storage']);
  assert.equal(lastGraph().nodes.length, 3, 'the original stays');
});

test('pasting text that is not a selection is left alone', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  const before = opsSent().length;
  await act(async () => {
    fireEvent.paste(document.body, { clipboardData: { getData: () => 'just some words' } });
  });
  assert.equal(opsSent().length, before);
});

test('double-clicking empty canvas adds a box and names it in place', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__pane')));
  await act(async () => {
    fireEvent.doubleClick(document.querySelector('.react-flow__pane')!);
  });
  assert.ok(lastGraph().nodes.some((n) => n['id'] === 'n3' && n['label'] === 'New component'));
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.flow-node-input');
    assert.ok(el);
    return el;
  });
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Rate limiter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  assert.equal(lastGraph().nodes.find((n) => n['id'] === 'n3')!['label'], 'Rate limiter');
});

test("a connection's direction, arrowheads and label are edited in its panel", async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  await act(async () => {
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Details' })).getByText(/→ Postgres/));
  });
  const panel = screen.getByRole('complementary', { name: 'Details' });
  assert.ok(within(panel).getByLabelText('Arrow label'));
  await act(async () => {
    fireEvent.click(within(panel).getByRole('button', { name: 'Reverse direction' }));
  });
  assert.deepEqual(lastGraph().edges.map((e) => [e['source'], e['target']]), [['db', 'api']]);
  await act(async () => {
    fireEvent.click(within(panel).getByRole('radio', { name: '↔' }));
  });
  assert.equal(lastGraph().edges[0]!['arrows'], 'both');
  await act(async () => {
    fireEvent.click(within(panel).getByRole('radio', { name: 'Dashed' }));
  });
  assert.equal(lastGraph().edges[0]!['dashed'], true);
});

test('a box can be connected, and disconnected, from its panel', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  let panel = screen.getByRole('complementary', { name: 'Details' });
  await act(async () => {
    fireEvent.change(within(panel).getByLabelText('Connect Postgres to'), { target: { value: 'api' } });
  });
  assert.ok(lastGraph().edges.some((e) => e['source'] === 'db' && e['target'] === 'api'));
  panel = screen.getByRole('complementary', { name: 'Details' });
  await act(async () => {
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove connection to API' }));
  });
  assert.deepEqual(lastGraph().edges.map((e) => [e['source'], e['target']]), [['api', 'db']], 'only the one asked for goes');
});

test('"Copy as Markdown" copies the diagram as Claude reads it', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
  });
  await waitFor(() => assert.match(copied, /^### \[d1\] Components/));
  assert.match(copied, /\*\*Postgres\*\* `db` — data store\n  Decisions:\n    Primary store\./);
  assert.match(copied, /- API → Postgres: SQL `api → db`/);
  assert.doesNotMatch(copied, /"x"|x: /);
});

test('a title edit elsewhere does not make the next canvas save stale', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  // Renamed in another tab: the diagram's revision moves, its graph does not.
  const s = store.getState().session!;
  const plan = structuredClone(s.plan!);
  plan.diagrams[0]!.rev += 1;
  plan.diagrams[0]!.title = 'Renamed elsewhere';
  plan.version += 1;
  await act(async () => {
    store.apply({ type: 'snapshot', session: { ...s, plan } });
  });
  await selectBox('API');
  await act(async () => {
    fireEvent.change(within(screen.getByRole('complementary', { name: 'Details' })).getByLabelText('Link a task to API'), { target: { value: 't3' } });
  });
  const op = opsSent().filter((o) => o['op'] === 'upsert_diagram').at(-1)!;
  assert.equal(op['expect'], plan.diagrams[0]!.rev, 'saved against the revision now current');
});

test('a late answer never rolls the page back past a newer version', async () => {
  await boot();
  const s = store.getState().session!;
  const older = { ...s.plan!, title: 'Older', version: s.plan!.version + 1 };
  store.set({ session: { ...s, plan: { ...s.plan!, title: 'Newer', version: s.plan!.version + 2 } } });
  stubFetch((route) => (route.endsWith('/plan/ops') ? { plan: older, changes: [] } : { ok: true }));
  await act(async () => {
    await store.commit([{ op: 'set_meta', title: 'Older' }]);
  });
  assert.equal(store.getState().session?.plan?.title, 'Newer');
});

test('moving a box with the arrow keys is saved', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find((n) => n.textContent?.includes('API'))!;
  const before = opsSent().length;
  await act(async () => {
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    fireEvent.keyDown(node, { key: 'ArrowRight' });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  assert.ok(opsSent().length > before, 'a save followed the keys');
  assert.equal(opsSent().length - before, 1, 'one save for the run of keys, not one per press');
});

test('a keyboard move is saved even when the diagram closes straight after', async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find((n) => n.textContent?.includes('API'))!;
  const before = opsSent().length;
  await act(async () => {
    fireEvent.keyDown(node, { key: 'ArrowRight' });
  });
  await act(async () => {
    cleanup();
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(opsSent().length - before, 1, 'saved on the way out');
});

test("a canvas save still pending when the session changes goes to the session it was made in", async () => {
  await boot();
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('API');
  const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find((n) => n.textContent?.includes('API'))!;
  await act(async () => {
    fireEvent.keyDown(node, { key: 'ArrowRight' });
  });
  // Another session with the same plan shape — its first diagram is d1 too.
  await act(async () => {
    store.set({ sessionId: 's2', session: makeSession(makePlan(), { sessionId: 's2' }) });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  const saves = posts.filter((p) => p.route.endsWith('/plan/ops') && (p.body['ops'] as { op: string }[]).some((o) => o.op === 'upsert_diagram'));
  assert.ok(saves.length > 0, 'the move was saved');
  assert.ok(saves.every((p) => p.route.includes('/session/s1/')), `never into s2: ${saves.map((p) => p.route).join(', ')}`);
});

test('an answer from a daemon that predates version is still applied', async () => {
  await boot();
  const s = store.getState().session!;
  const legacy = { ...s.plan!, title: 'From the old daemon', seq: s.plan!.seq + 1 } as Partial<Plan>;
  delete legacy.version;
  store.set({ session: { ...s, plan: { ...s.plan!, version: undefined as unknown as number } } });
  stubFetch((route) => (route.endsWith('/plan/ops') ? { plan: legacy, changes: [] } : { ok: true }));
  await act(async () => {
    await store.commit([{ op: 'set_meta', title: 'From the old daemon' }]);
  });
  assert.equal(store.getState().session?.plan?.title, 'From the old daemon');
});

test('a summary says how many connections it left out', async () => {
  const targets = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const plan = publishPlan(
    null,
    {
      title: 'Hub',
      diagrams: [
        {
          title: 'D',
          nodes: [{ id: 'hub', label: 'Hub', kind: 'service' }, ...targets.map((t) => ({ id: t, label: t.toUpperCase(), kind: 'component' }))],
          edges: targets.map((t) => ({ source: 'hub', target: t })),
        },
      ],
    },
    Date.now(),
  ).plan;
  await boot(makeSession(plan));
  const info = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button[aria-label="About Hub"]');
    assert.ok(el);
    return el;
  });
  await act(async () => {
    fireEvent.mouseEnter(info);
  });
  await waitFor(() => assert.match(document.querySelector('.flow-summary')?.textContent ?? '', /and 2 more/));
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

/** Each "By box" group: its name, and the tasks listed under it. */
const byBox = () =>
  [...document.querySelectorAll<HTMLElement>('.by-box-group')].map((g) => [
    g.querySelector('.by-box-name')?.textContent,
    ...[...g.querySelectorAll('.by-box-row')].map((r) => `${r.querySelector('.task-num')?.textContent} ${r.querySelector('.by-box-title')?.textContent}`),
  ]);

test('"By box" lists every task under each box it builds, and the tasks that build none apart', async () => {
  const plan = applyOps(makePlan(), [{ op: 'upsert_task', title: 'Health check', builds: ['api', 'db'] }], 'user').plan;
  await boot(makeSession(plan));
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'By box' }));
  });
  assert.equal(store.getState().taskMode, 'boxes');
  assert.deepEqual(byBox(), [
    ['API', '3 Health check'],
    ['Postgres', '1 Storage layer', '1.1 Cache client', '1.2 Invalidation', '3 Health check'],
    ['Not on the diagram', '2 Wire into API'],
  ]);
  const postgres = screen.getByRole('region', { name: 'Postgres' });
  assert.match(postgres.textContent ?? '', /1\/3/, 'how far along the tasks that build it are');
  assert.ok(within(postgres).getByRole('button', { name: 'Brief for Storage layer' }), 'each with its brief');
  await act(async () => {
    fireEvent.click(within(postgres).getByRole('button', { name: 'Postgres' }));
  });
  assert.equal(store.getState().tab, 'diagrams', 'a box opens on the canvas');
  assert.equal(store.getState().focusTarget === null || store.getState().focusTarget === 'node:d1:db', true);
});

test('"By box" marks a box no task builds, as the plan check would', async () => {
  await boot();
  await openTab('Tasks');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'By box' }));
  });
  const api = screen.getByRole('region', { name: 'API' });
  assert.match(api.textContent ?? '', /no task/);
  assert.match(api.textContent ?? '', /No task builds this box/);
  assert.doesNotMatch(screen.getByRole('region', { name: 'Postgres' }).textContent ?? '', /no task/);
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
  assert.deepEqual(opsSent()[0], { op: 'upsert_section', id: 's1', body: 'Reads take 400ms.', expect: 1 }, 'made against the revision edited');
});

test('a refused save keeps the editor open with the text intact', async () => {
  await boot();
  await openTab('Overview');
  // The daemon refuses: the section moved on underneath.
  stubFetch((route) => {
    if (route.endsWith('/plan/ops')) return { __status: 400, error: 'Section "Context" was changed by Claude while this edit was open, so it was not saved.' };
    return { ok: true };
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Edit section "Context"'));
  });
  const area = screen.getByLabelText('section "Context"') as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(area, { target: { value: 'My careful rewrite.' } });
  });
  await act(async () => {
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
  });
  const still = screen.getByLabelText('section "Context"') as HTMLTextAreaElement;
  assert.equal(still.value, 'My careful rewrite.', 'nothing typed is lost');
  assert.ok(store.getState().toasts.some((t) => /changed by Claude/.test(t.text)), 'and the reason is shown');
});

test('a view that throws takes only itself down', async () => {
  const broken = makePlan();
  // A shape only the canvas reads, and does not expect: arrows not a list.
  (broken.diagrams[0] as unknown as Record<string, unknown>)['edges'] = null;
  const quiet = console.error;
  console.error = () => {};
  await boot(makeSession(broken));
  console.error = quiet;
  assert.ok(screen.getByRole('alert'));
  assert.match(screen.getByRole('alert').textContent ?? '', /could not be shown/);
  assert.ok(screen.getAllByRole('tab').length === 3, 'the rest of the page still works');
  await openTab('Tasks');
  assert.ok(document.querySelector('.task-line'), 'and the other views render');
});

test('while a session loads, the page says so instead of "no session"', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    return { ok: true };
  });
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    value: async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith('/api/session/')) await gate;
      return original(input as string, init);
    },
    configurable: true,
    writable: true,
  });
  render(<App />);
  await act(async () => {
    void store.init();
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.ok(screen.getByText('Loading the plan…'));
  assert.equal(screen.queryByText('No session yet'), null);
  release();
});

test('a page without the harness key says how to open it properly', async () => {
  stubFetch(() => ({ __status: 401, error: 'unauthorized' }));
  render(<App />);
  await act(async () => {
    await store.init();
  });
  assert.ok(screen.getByText('This page is not signed in to Coplan'));
  assert.match(document.body.textContent ?? '', /coplan open/);
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

test('a snapshot older than the plan on the page never rolls it back', async () => {
  const plan = makePlan();
  plan.version = 10;
  plan.title = 'Newest';
  await boot(makeSession(plan));
  const older = makePlan();
  older.version = 9;
  older.title = 'Older';
  await act(async () => {
    store.apply({ type: 'snapshot', session: makeSession(older, { title: 'Session renamed' }) });
  });
  assert.equal(store.getState().session?.plan?.title, 'Newest');
  assert.equal(store.getState().session?.title, 'Session renamed', 'the rest of the session still updates');
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

/* ------------------------------------------------- submitting the plan */

/** The plan once the user confirmed its design. */
function confirmedPlan(plan: Plan = makePlan()): Plan {
  return confirmDesign(plan, { prompt: '[cc-harness] The design is confirmed for "Add a cache"\n\nTHE DESIGN' });
}

/** The plan after the user submitted it — handed to Claude, if `delivered`. */
function lockedPlan(delivered = false): Plan {
  const plan = submitPlan(confirmedPlan(), { target: 'session', prompt: '[cc-harness] Build the plan "Add a cache"\n\nTHE PROMPT' });
  return delivered ? markDelivered(plan) : plan;
}

const DEFAULTS = { review: 'subagent', parallel: 2, maxRounds: 3 };

test('the design is confirmed from the architecture view, after reading what Claude will be asked', async () => {
  const session = makeSession();
  const version = session.plan!.version;
  await boot(session, (route, init) => {
    if (route.endsWith('/plan/design/prompt')) {
      const { note } = JSON.parse(String(init?.body)) as { note: string };
      return { prompt: `DESIGN PROMPT${note ? ` with "${note}"` : ''}`, trimmed: false, version, budget: 9000, maxNote: 4000 };
    }
    if (route.endsWith('/plan/design/confirm')) return { plan: confirmedPlan() };
    return undefined;
  });
  assert.equal(screen.queryByRole('button', { name: 'Review & submit plan' }), null, 'the design comes first');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm design' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Confirm the design' });
  const preview = () => within(dialog).getByTestId('prompt-preview').textContent;
  await waitFor(() => assert.equal(preview(), 'DESIGN PROMPT'));
  assert.match(dialog.textContent ?? '', /1 diagram · 2 boxes · 4 planned tasks/);
  assert.match(dialog.textContent ?? '', /locks the design/);
  // What the agent's harness_plan_check would say, before the user signs off.
  assert.match(dialog.textContent ?? '', /\d+ gaps? the plan leaves open/);
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText('Anything else for Claude?'), { target: { value: 'split storage' } });
  });
  await waitFor(() => assert.equal(preview(), 'DESIGN PROMPT with "split storage"'));
  const confirm = within(dialog).getByRole('button', { name: 'Confirm design' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(confirm.disabled, false));
  await act(async () => {
    fireEvent.click(confirm);
  });
  const sent = posts.find((p) => p.route.endsWith('/plan/design/confirm'));
  assert.deepEqual(sent?.body, { note: 'split storage', expect: version });
  assert.equal(screen.queryByRole('dialog'), null);

  // Confirmed: the canvas shows the design, and the next step is the tasks.
  assert.ok(screen.getByText('Design confirmed', { selector: '.flow-locked' }));
  assert.equal(screen.queryByRole('button', { name: /\+ Box/ }), null);
  assert.ok(screen.getByRole('button', { name: 'Review & submit plan' }));
  const strip = screen.getByRole('region', { name: 'The design' });
  assert.match(strip.textContent ?? '', /Planning · design confirmed — waiting for Claude/);
  // One status, in the same words in the header (#66).
  assert.match(screen.getByTestId('plan-status').textContent ?? '', /^✎ Planning · design confirmed$/);
});

test('the sign-off dialogs list each setting from config, read-only, with the file and key that set it', async () => {
  const { designPrompt, configRows, promptHash } = await import('../daemon/render.ts');
  const { parseProjectConfig } = await import('../shared/project.ts');
  const project = parseProjectConfig({ hooks: { review: [{ name: 'tests', run: 'npm test' }] }, iric: { review: 'self' }, review: { model: 'opus' } });
  const session = makeSession();
  const version = session.plan!.version;
  await boot(session, (route) => {
    if (route.endsWith('/plan/design/prompt')) {
      const { prompt, trimmed, blocks } = designPrompt(session.plan!, { project });
      return { prompt, hash: promptHash(prompt), trimmed, blocks, version, budget: 9000, maxNote: 4000, project: { file: '/repo/.coplan/config.json', defaults: DEFAULTS, checks: { implement: [], review: ['tests'], final: [] }, errors: [], config: configRows(project, 'design') } };
    }
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm design' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Confirm the design' });
  const list = await waitFor(() => within(dialog).getByRole('region', { name: 'Set in config' }));
  const row = (key: string) => list.querySelector(`[data-key="${key}"]`) as HTMLElement;
  const file = (key: string) => row(key).closest('.config-group')?.querySelector('.config-file')?.textContent;
  assert.match(row('hooks.review').textContent ?? '', /^Review checks#hooks\.reviewtests$/);
  assert.equal(file('hooks.review'), '.coplan/config.json');
  // The design prompt's review mode is the config's default: shown, since no control here sets it.
  assert.match(row('iric.review').textContent ?? '', /Review, by default#iric\.reviewself-review/);
  assert.equal(file('iric.review'), '.coplan/config.json');
  assert.match(row('hooks.final').textContent ?? '', /Final checks\.coplan\/config\.json#hooks\.finalnone/);
  assert.equal(file('hooks.final'), "Not set: Coplan's defaults");
  assert.equal(within(list).queryAllByRole('textbox').length + within(list).queryAllByRole('checkbox').length, 0, 'read-only');
  assert.equal(within(row('hooks.review')).getByRole('link').getAttribute('href'), 'https://github.com/bert-bae/coplan/blob/main/docs/CONFIG.md#hooks');
  assert.equal(within(list).getByRole('link', { name: 'Where to change these' }).getAttribute('href'), 'https://github.com/bert-bae/coplan/blob/main/docs/CONFIG.md');
  // Pull requests and the reviewer model shape the build, not the design: they are in Submit.
  assert.equal(within(list).queryByText('Reviewer model'), null);
});

test("a chip in the sign-off dialog shows the field it quotes, and the dialog keeps the note for when it opens again", async () => {
  const session = makeSession();
  await boot(session, await viewerRoutes(session));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm design' }));
  });
  let dialog = screen.getByRole('dialog', { name: 'Confirm the design' });
  await waitFor(() => assert.ok(within(dialog).getByRole('button', { name: 'Section · Context' })));
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText('Anything else for Claude?'), { target: { value: 'keep it small' } });
  });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Section · Context' }));
  });
  assert.equal(screen.queryByRole('dialog', { name: 'Confirm the design' }), null);
  assert.equal(store.getState().tab, 'overview');
  await waitFor(() => assert.ok(document.getElementById(`section-${session.plan!.sections[0]!.id}`)?.classList.contains('is-flash')));
  await openTab('Architecture');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm design' }));
  });
  dialog = screen.getByRole('dialog', { name: 'Confirm the design' });
  assert.equal((within(dialog).getByLabelText('Anything else for Claude?') as HTMLTextAreaElement).value, 'keep it small');
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText('Anything else for Claude?'), { target: { value: '' } });
  });
});

test('a prompt cut to fit says what it leaves out, and that the agent reads it with harness_plan_read', async () => {
  const { buildPrompt, configRows, promptHash } = await import('../daemon/render.ts');
  const { parseProjectConfig } = await import('../shared/project.ts');
  const project = parseProjectConfig({ review: { model: 'opus' } });
  const long = 'A long paragraph of detail that goes on and on about the work. '.repeat(20);
  let plan = makePlan();
  plan = confirmedPlan(applyOps(plan, [{ op: 'upsert_section', id: plan.sections[0]!.id, body: long.repeat(8) }], 'claude').plan);
  const session = makeSession(plan);
  await boot(session, (route) => {
    if (route.endsWith('/plan/prompt')) {
      const { prompt, trimmed, blocks } = buildPrompt(plan, { target: 'session', project, settings: { review: 'subagent', parallel: 2, maxRounds: 3 } });
      return { prompt, hash: promptHash(prompt), trimmed, blocks, version: plan.version, budget: 9000, maxNote: 4000, settings: DEFAULTS, project: { file: null, defaults: DEFAULTS, checks: { implement: [], review: [], final: [] }, errors: [], config: configRows(project, 'build') } };
    }
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review & submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  await waitFor(() => assert.match(dialog.textContent ?? '', /The plan is longer than fits in one message: it leaves out 1 section and the architecture \(1 diagram\), so Claude reads it with harness_plan_read\./));
  const list = within(dialog).getByRole('region', { name: 'Set in config' });
  assert.equal(list.querySelector('[data-key="review.model"]')?.textContent, 'Reviewer model#review.modelopus');
  assert.equal(list.querySelector('[data-key="pullRequests"]')?.textContent, 'Pull requests.coplan/config.json#pullRequestsgh pr create, once you say');
  assert.match(list.querySelector('[data-key="instructions.build"]')?.textContent ?? '', /none$/);
});

test('with the design confirmed, boxes still link to tasks but nothing else on them changes', async () => {
  await boot(makeSession(confirmedPlan()));
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  await waitFor(() => assert.match(panel.textContent ?? '', /Built by/));
  assert.equal(within(panel).queryAllByRole('textbox').length, 0, 'the design itself is read-only');
  await act(async () => {
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Link a task to Postgres' }), { target: { value: 't3' } });
  });
  const op = opsSent().find((o) => o['op'] === 'upsert_diagram')!;
  const db = (op['nodes'] as { id: string; taskIds?: string[] }[]).find((n) => n.id === 'db');
  assert.deepEqual(db?.taskIds, ['storage', 't3']);
});

test('the task list says what waits on what, and the order the build takes', async () => {
  let plan = confirmedPlan();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't3', status: 'todo', dependsOn: ['storage'], branch: 'cache/api', review: 'user' }], 'claude', undefined, { tracking: true }).plan;
  await boot(makeSession(plan));
  await openTab('Tasks');
  const row = document.getElementById('task-t3')!;
  assert.match(row.textContent ?? '', /after 1/);
  assert.match(row.textContent ?? '', /cache\/api/);
  assert.match(row.textContent ?? '', /review: you review/);
  assert.match(row.textContent ?? '', /waits on 1/);
  assert.match(document.getElementById('task-t2')?.textContent ?? '', /ready/);
  const order = screen.getByRole('region', { name: 'Build order' });
  assert.match(order.textContent ?? '', /Step 1/);
  assert.match(order.textContent ?? '', /Step 2/);
  assert.match(order.textContent ?? '', /cache\/api/);
  assert.ok(screen.getByRole('button', { name: 'Review & submit plan' }), 'submitted from the tasks, too');

  // Dependencies are edited in a task's details.
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: 'Details of Wire into API' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting on Storage layer' }));
  });
  // Made against the revision on screen (Claude's edit above made it 2), so a newer change is not undone.
  assert.deepEqual(opsSent().at(-1), { op: 'upsert_task', id: 't3', dependsOn: [], expect: 2 });
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Self-review' }));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'upsert_task', id: 't3', review: 'self', expect: 2 });
});

test('a gap the repository counts as an error holds Submit, and is shown first', async () => {
  const plan = confirmedPlan();
  const { planGaps } = await import('../shared/check.ts');
  const rule = planGaps(plan)[0]?.rule;
  assert.ok(rule, 'the fixture leaves a gap open');
  await boot(makeSession(plan), (route) => {
    if (route.endsWith('/plan/prompt')) {
      return {
        prompt: 'PROMPT',
        trimmed: false,
        version: plan.version,
        budget: 9000,
        maxNote: 4000,
        settings: DEFAULTS,
        project: { file: '/repo/.coplan/config.json', defaults: DEFAULTS, checks: { implement: [], review: [], final: [] }, errors: [], planCheck: { [rule]: 'error' } },
      };
    }
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review & submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  await waitFor(() => assert.equal(within(dialog).getByTestId('prompt-preview').textContent, 'PROMPT'));
  const submit = within(dialog).getByRole('button', { name: 'Submit and lock' }) as HTMLButtonElement;
  assert.equal(submit.disabled, true, 'held by the error');
  assert.equal(submit.title, 'Fix the gaps this repository counts as errors first');
  assert.match(dialog.textContent ?? '', /gaps the plan leaves open — (one is an error|\d+ are errors) in this repository, to fix first/);
  assert.match(dialog.querySelector('.submit-gap-error')?.textContent ?? '', /^Error: /);
});

test('the plan is submitted after reading the prompt it sends, with how the build runs', async () => {
  const session = makeSession(confirmedPlan());
  const version = session.plan!.version;
  await boot(session, (route, init) => {
    if (route.endsWith('/plan/prompt')) {
      const { mode, note, settings } = JSON.parse(String(init?.body)) as { mode?: string; note: string; settings?: typeof DEFAULTS };
      const used = settings ?? DEFAULTS;
      return {
        prompt: `PROMPT for ${mode ?? 'the default'}${note ? ` with "${note}"` : ''}${settings ? ` reviewed by ${settings.review}` : ''}`,
        trimmed: false,
        version,
        budget: 9000,
        maxNote: 4000,
        mode: mode ?? 'managed',
        settings: used,
        project: { file: null, mode: 'managed', defaults: DEFAULTS, checks: { implement: [], review: [], final: [] }, errors: [] },
      };
    }
    if (route.endsWith('/plan/submit')) return { plan: lockedPlan() };
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review & submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  const preview = () => within(dialog).getByTestId('prompt-preview').textContent;
  // The repository's defaults — its mode, its settings — come with the
  // first preview, and are then what the prompt is built from.
  await waitFor(() => assert.equal(preview(), 'PROMPT for managed reviewed by subagent'));
  assert.equal((within(dialog).getByLabelText(/^Managed/) as HTMLInputElement).checked, true);
  assert.match(within(dialog).getByLabelText(/^Managed/).closest('label')?.textContent ?? '', /this repository's default/);
  assert.match(dialog.textContent ?? '', /1 diagram · 2 boxes · 3 tasks \(1 already done\)/);
  assert.match(dialog.textContent ?? '', /No checks are set up/);

  // What is on screen is what is sent: the button waits for the preview.
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText('Anything else for Claude?'), { target: { value: 'tests first' } });
  });
  const submit = within(dialog).getByRole('button', { name: 'Submit and lock' }) as HTMLButtonElement;
  assert.equal(submit.disabled, true, 'not while the preview is out of date');
  await waitFor(() => assert.equal(preview(), 'PROMPT for managed with "tests first" reviewed by subagent'));
  await waitFor(() => assert.equal(submit.disabled, false));
  // A canvas edit still on its way to the daemon would be missing from the plan that locks.
  act(() => store.set({ canvasSaving: true }));
  assert.equal(submit.disabled, true, 'not while the canvas is still saving');
  act(() => store.set({ canvasSaving: false }));
  assert.equal(submit.disabled, false);

  // The user's control over each task's cycle: who reviews it.
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('radio', { name: 'You review' }));
  });
  await waitFor(() => assert.equal(preview(), 'PROMPT for managed with "tests first" reviewed by user'));

  // Tracked leaves the cycle to the agent: no review, round or parallel settings.
  await act(async () => {
    fireEvent.click(within(dialog).getByLabelText(/^Tracked/));
  });
  await waitFor(() => assert.equal(preview(), 'PROMPT for tracked with "tests first" reviewed by user'));
  assert.equal(within(dialog).queryByRole('radio', { name: 'You review' }), null);
  // Export rebuilds it as the plan alone, copied rather than sent.
  await act(async () => {
    fireEvent.click(within(dialog).getByLabelText(/^Export/));
  });
  await waitFor(() => assert.equal(preview(), 'PROMPT for export with "tests first" reviewed by user'));
  assert.ok(within(dialog).getByRole('button', { name: 'Copy and lock' }));
  assert.match(dialog.textContent ?? '', /The plan, as Markdown/);
  await act(async () => {
    fireEvent.click(within(dialog).getByLabelText(/^Managed/));
  });
  await waitFor(() => assert.equal(preview(), 'PROMPT for managed with "tests first" reviewed by user'));
  await waitFor(() => assert.equal(submit.disabled, false));

  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit and lock' }));
  });
  const sent = posts.find((p) => p.route.endsWith('/plan/submit'));
  assert.deepEqual(sent?.body, { target: 'session', mode: 'managed', note: 'tests first', expect: version, settings: { ...DEFAULTS, review: 'user' } });
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(store.getState().tab, 'tasks', 'the board is where the build is followed');
  assert.ok(screen.getByRole('region', { name: 'To do' }));
});

test('a repository with no iric submits Tracked by default, with no review settings to choose (#62)', async () => {
  const session = makeSession(confirmedPlan());
  const version = session.plan!.version;
  await boot(session, (route, init) => {
    if (route.endsWith('/plan/prompt')) {
      const { mode } = JSON.parse(String(init?.body)) as { mode?: string };
      return {
        prompt: `PROMPT for ${mode ?? 'the default'}`,
        trimmed: false,
        version,
        budget: 9000,
        maxNote: 4000,
        mode: mode ?? 'tracked',
        settings: DEFAULTS,
        project: { file: null, mode: 'tracked', defaults: DEFAULTS, checks: { implement: [], review: [], final: [] }, errors: [] },
      };
    }
    if (route.endsWith('/plan/submit')) return { plan: lockedPlan() };
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review & submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  await waitFor(() => assert.equal(within(dialog).getByTestId('prompt-preview').textContent, 'PROMPT for tracked'));
  assert.equal((within(dialog).getByLabelText(/^Tracked/) as HTMLInputElement).checked, true);
  assert.equal(within(dialog).queryByRole('radiogroup', { name: 'Who reviews each task' }), null);
  const submit = within(dialog).getByRole('button', { name: 'Submit and lock' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(submit.disabled, false));
  await act(async () => {
    fireEvent.click(submit);
  });
  const sent = posts.find((p) => p.route.endsWith('/plan/submit'));
  assert.deepEqual(sent?.body, { target: 'session', mode: 'tracked', note: '', expect: version }, "a Tracked build carries no cycle settings");
});

test('Export plan opens from every view and phase, and copies the plan with no sign-off (#62)', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  const exported = { text: '# Add a cache\n\n## Summary\nA cache.', blocks: [{ id: 'heading', source: { kind: 'field', target: { kind: 'plan', id: '' } }, text: '# Add a cache' }, { id: 'summary', source: { kind: 'field', target: { kind: 'plan', id: '' } }, text: '\n## Summary\nA cache.' }], version: 0 };
  for (const plan of [makePlan(), confirmedPlan(), lockedPlan(true)]) {
    cleanup();
    store.set({ tab: 'diagrams', exportOpen: false, viewer: null });
    await boot(makeSession(plan), (route) => (route.endsWith('/plan/export') ? { ...exported, version: plan.version } : undefined));
    const before = posts.length;
    for (const tab of ['Architecture', 'Tasks', 'Overview']) {
      await openTab(tab);
      assert.ok(screen.getByRole('button', { name: 'Export plan' }), `on ${tab}, in phase ${plan.submission ? 'built' : plan.design ? 'tasking' : 'planning'}`);
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export plan' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'Export the plan' });
    await waitFor(() => assert.match(within(dialog).getByTestId('export-text').textContent ?? '', /## Summary/));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    });
    assert.equal(copied, exported.text);
    assert.deepEqual(posts.slice(before), [], 'nothing is signed off or saved');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    assert.equal(screen.queryByRole('dialog', { name: 'Export the plan' }), null);
  }
});

test('a submitted plan is locked: the canvas shows the design, and the strip says how to hand it over', async () => {
  await boot(makeSession(lockedPlan()));
  assert.equal(screen.queryByRole('button', { name: 'Review & submit plan' }), null);
  assert.equal(screen.queryByRole('button', { name: /\+ Box/ }), null);
  assert.equal(screen.queryByRole('button', { name: /New diagram/ }), null);
  assert.ok(screen.getByText('Final design'));
  const strip = screen.getByRole('region', { name: 'The build' });
  assert.match(strip.textContent ?? '', /In progress · waiting for Claude to start/);
  assert.match(screen.getByTestId('plan-status').textContent ?? '', /^▶ In progress · waiting for Claude$/);
  assert.match(strip.textContent ?? '', /Send any message in Claude's chat/);

  // A box reads its details; nothing there edits it.
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
  await selectBox('Postgres');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  await waitFor(() => assert.match(panel.textContent ?? '', /Built by/));
  assert.match(panel.textContent ?? '', /Primary store\./);
  assert.equal(within(panel).queryAllByRole('textbox').length, 0);
  assert.equal(within(panel).queryAllByRole('combobox').length, 0);

  // Typing on a selected box does not rename it, and nothing is saved.
  await act(async () => {
    fireEvent.keyDown(document.body, { key: 'x' });
    fireEvent.keyDown(document.body, { key: 'Delete' });
  });
  assert.equal(document.querySelector('.flow-node-input'), null);
  assert.equal(opsSent().length, 0);
});

test('a plan signed off in chat says so, with the words the user said there (#65)', async () => {
  const design = confirmDesign(makePlan(), { prompt: '[cc-harness] The design is confirmed\n\nTHE DESIGN', userSaid: 'the design is right' });
  await boot(makeSession(design));
  const tasking = screen.getByRole('region', { name: 'The design' });
  assert.match(tasking.textContent ?? '', /confirmed from chat/);
  assert.match(within(tasking).getByTestId('said-in-chat').textContent ?? '', /^You told Claude in chat: the design is right$/);

  cleanup();
  const built = markDelivered(submitPlan(makePlan(), { target: 'session', mode: 'tracked', prompt: '[cc-harness] Build the plan\n\nTHE PROMPT', userSaid: 'looks good, build it' }));
  await boot(makeSession(built));
  const strip = screen.getByRole('region', { name: 'The build' });
  assert.match(strip.textContent ?? '', /submitted from chat/);
  assert.match(within(strip).getByTestId('said-in-chat').textContent ?? '', /^You told Claude in chat: looks good, build it$/);
  assert.match(screen.getByTestId('plan-status').getAttribute('title') ?? '', /Submitted from chat: “looks good, build it”/);
  // Reopened, a plan that skipped Confirm design is back to planning.
  assert.match(strip.textContent ?? '', /Reopen for changes/);
  // A sign-off made in the page says nothing of the kind.
  cleanup();
  await boot(makeSession(lockedPlan(true)));
  assert.equal(screen.queryByTestId('said-in-chat'), null);
  assert.doesNotMatch(screen.getByRole('region', { name: 'The build' }).textContent ?? '', /from chat/);
});

test('confirming the design is optional: Submit is offered while designing, and what is chosen there is kept for chat (#65)', async () => {
  const session = makeSession();
  const version = session.plan!.version;
  await boot(session, (route, init) => {
    if (route.endsWith('/plan/prompt')) {
      const { mode } = JSON.parse(String(init?.body)) as { mode?: string };
      return {
        prompt: `PROMPT for ${mode ?? 'the default'}`,
        trimmed: false,
        version,
        budget: 9000,
        maxNote: 4000,
        mode: mode ?? 'tracked',
        settings: DEFAULTS,
        project: { file: null, mode: 'tracked', defaults: DEFAULTS, checks: { implement: [], review: [], final: [] }, errors: [] },
      };
    }
    return undefined;
  });
  assert.ok(screen.getByRole('button', { name: 'Confirm design' }), 'the checkpoint is still offered');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  // The repository's default (Tracked here) until the user picks another.
  await waitFor(() => assert.equal(within(dialog).getByTestId('prompt-preview').textContent, 'PROMPT for tracked'));
  assert.match(dialog.textContent ?? '', /The design is not confirmed: the build follows the tasks planned on the diagram/);
  assert.match(dialog.textContent ?? '', /Or skip this dialog: tell Claude in chat — build it — and it signs this off for you, built the way you last chose here/);
  // Choosing how it is built is remembered, for a go-ahead given in chat.
  await act(async () => {
    fireEvent.click(within(dialog).getByLabelText(/^Managed/));
  });
  await waitFor(() => assert.ok(posts.some((p) => p.route.endsWith('/plan/choice'))));
  assert.deepEqual(posts.filter((p) => p.route.endsWith('/plan/choice')).at(-1)?.body, { mode: 'managed', settings: DEFAULTS });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Self-review' }));
  });
  assert.deepEqual(posts.filter((p) => p.route.endsWith('/plan/choice')).at(-1)?.body, { mode: 'managed', settings: { ...DEFAULTS, review: 'self' } });
  assert.equal(posts.filter((p) => p.route.endsWith('/plan/submit')).length, 0, 'choosing submits nothing');
});

test('withdrawing a submission Claude has not picked up unlocks the plan', async () => {
  const locked = lockedPlan();
  // As the daemon answers: the same plan, unlocked, one version on.
  await boot(makeSession(locked), (route) => (route.endsWith('/plan/reopen') ? { plan: reopenPlan(locked) } : undefined));
  const strip = screen.getByRole('region', { name: 'The build' });
  await act(async () => {
    fireEvent.click(within(strip).getByRole('button', { name: 'Withdraw' }));
  });
  await act(async () => {
    fireEvent.click(within(strip).getByRole('button', { name: 'Withdraw' }));
  });
  assert.ok(posts.some((p) => p.route.endsWith('/plan/reopen')));
  assert.ok(screen.getByRole('button', { name: 'Review & submit plan' }), 'the tasks are open again; the design stays confirmed');
  assert.ok(screen.getByRole('region', { name: 'The design' }));
});

test('the submitted prompt can be read back from the architecture view', async () => {
  await boot(makeSession(lockedPlan(true)));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'View prompt' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'What Claude reads' });
  assert.equal(within(dialog).getByRole('tab', { name: 'Sent prompt' }).getAttribute('aria-selected'), 'true');
  await waitFor(() => assert.match(within(dialog).getByTestId('viewer-text').textContent ?? '', /THE PROMPT/));
  assert.match(dialog.textContent ?? '', /The submitted prompt, exactly as it was sent · submitted .* · Claude got it/);
});

test('while building, the board follows Claude and a card that moves stands out', async () => {
  const plan = lockedPlan(true);
  await boot(makeSession(plan));
  await openTab('Tasks');
  const layouts = within(screen.getByRole('group', { name: 'Task layout' })).getAllByRole('button').map((b) => b.textContent);
  assert.deepEqual(layouts, ['Board', 'By box'], 'the board, or by box: no outline to reshape');
  assert.match(document.querySelector('.toolbar-note')?.textContent ?? '', /Cards move across the board as Claude reports each task/);
  assert.equal(screen.queryAllByRole('combobox').length, 0, 'no status pickers');
  assert.equal(document.querySelector('[draggable="true"]'), null, 'nothing to drag');
  const strip = screen.getByRole('region', { name: 'The build' });
  assert.match(strip.textContent ?? '', /In progress · building/);
  assert.match(strip.textContent ?? '', /Claude is on Wire into API/);

  // Claude reports a task done: it arrives in the Done column, and says so.
  const next = applyOps(plan, [{ op: 'upsert_task', id: 't2', status: 'done', note: 'TTL-based' }], 'claude', undefined, { tracking: true }).plan;
  await act(async () => {
    store.apply({ type: 'snapshot', session: makeSession(next) });
  });
  const done = screen.getByRole('region', { name: 'Done' });
  const card = [...done.querySelectorAll('.board-card')].find((c) => c.textContent?.includes('Invalidation'))!;
  assert.ok(card, 'moved to Done');
  assert.ok(card.classList.contains('is-arrived'));
  assert.match(card.textContent ?? '', /TTL-based/);
  assert.match(document.querySelector('.board [aria-live]')?.textContent ?? '', /Invalidation: done/);
  // Cards already where they were do not.
  const still = [...done.querySelectorAll('.board-card')].find((c) => c.textContent?.includes('Cache client'))!;
  assert.equal(still.classList.contains('is-arrived'), false);
});

test('each card on the board says where its task is in implement → review → refine', async () => {
  let plan = lockedPlan(true);
  plan = applyOps(
    plan,
    [
      { op: 'upsert_task', id: 't3', stage: 'review' },
      { op: 'upsert_task', id: 't3', stage: 'refine', checks: [{ name: 'tests', ok: false, note: '2 failing' }, { name: 'typecheck', ok: true }] },
      { op: 'upsert_task', id: 't3', stage: 'review' },
    ],
    'claude',
    undefined,
    { tracking: true },
  ).plan;
  await boot(makeSession(plan));
  await openTab('Tasks');
  const card = document.getElementById('task-t3')!;
  assert.match(card.textContent ?? '', /in review · round 2/);
  assert.match(card.textContent ?? '', /✗ tests/);
  const strip = screen.getByRole('region', { name: 'The build' });
  assert.match(strip.textContent ?? '', /Claude is on Wire into API — in review, round 2/);
});

test("a task the user reviews waits for their verdict on its card", async () => {
  let plan = lockedPlan(true);
  plan.tasks.find((t) => t.id === 't3')!.review = 'user';
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't3', stage: 'review' }], 'claude', undefined, { tracking: true }).plan;
  await boot(makeSession(plan));
  // What was built waits on the user: the plan's status is Review (#66).
  assert.match(screen.getByTestId('plan-status').textContent ?? '', /^⏸ Review · 1 task waits on your review$/);
  const strip = screen.getByRole('region', { name: 'The build' });
  assert.match(strip.textContent ?? '', /Review · 1 task waits on your review/);
  assert.match(strip.textContent ?? '', /Wire into API waits on your review: approve it on its card in Tasks, or tell Claude in chat\./);
  await openTab('Tasks');
  const review = within(document.getElementById('task-t3')!).getByRole('group', { name: 'Your review of Wire into API' });
  await act(async () => {
    fireEvent.click(within(review).getByRole('button', { name: 'Request changes' }));
  });
  await act(async () => {
    fireEvent.change(within(review).getByLabelText('What to change'), { target: { value: 'Add a timeout' } });
  });
  await act(async () => {
    fireEvent.click(within(review).getByRole('button', { name: 'Send' }));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'review_task', id: 't3', verdict: 'changes', summary: 'Add a timeout' });
});

test('a submitted plan is followed by box too, beside the board, with nothing on it to edit', async () => {
  await boot(makeSession(lockedPlan(true)));
  await openTab('Tasks');
  assert.ok(document.querySelector('.board'), 'the board first');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'By box' }));
  });
  assert.ok(!document.querySelector('.board'));
  assert.deepEqual(byBox()[1]?.slice(0, 2), ['Postgres', '1 Storage layer']);
  const postgres = screen.getByRole('region', { name: 'Postgres' });
  assert.equal(within(postgres).queryAllByRole('button', { name: /Mark / }).length, 0, 'statuses are the agent’s to move');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
  });
  assert.ok(document.querySelector('.board'));
});

test("a box's task on a submitted plan opens its card on the board", async () => {
  await boot(makeSession(lockedPlan(true)));
  await act(async () => {
    store.focus('task', 't3');
  });
  assert.equal(store.getState().tab, 'tasks');
  await waitFor(() => assert.ok(document.getElementById('task-t3')?.classList.contains('board-card')));
});

test('the session rail says a plan is being built', async () => {
  await boot(makeSession(lockedPlan(true)), (route) =>
    route.startsWith('/api/sessions')
      ? {
          sessions: [
            {
              sessionId: 's1', agent: 'claude', title: 'repo', planTitle: 'Add a cache', cwd: '/repo', repoName: 'repo', repoRoot: '/repo', branch: 'main',
              status: 'active', createdAt: 1, updatedAt: 1, tasks: { total: 3, done: 1, inProgress: 1, blocked: 0 }, phase: 'building',
              current: 'Wire into API', waiting: null, surface: 'unknown', link: null, openThreads: 0, unreadByClaude: 0, engaged: true,
            },
          ],
          version: 'test',
        }
      : undefined,
  );
  // A summary from a daemon that predates statuses still shows one, from its phase.
  const rail = screen.getByRole('navigation', { name: 'Live sessions' });
  assert.ok(within(rail).getByText('In progress', { selector: '.status-pill' }));
});


/* ------------------------------------------------------ Codex and Cursor */

test('a Codex session is named Codex, and its question opens the thread in the Codex app', async () => {
  const link = { app: 'codex://threads/0199a213-81c0', web: null, via: 'app' as const };
  await boot(
    makeSession(makePlan(), {
      agent: 'codex',
      link,
      status: 'active',
      waiting: { kind: 'question', text: 'Which TTL?', questions: [{ question: 'Which TTL?', options: ['1m', '10m'] }], since: Date.now() },
    }),
  );
  const banner = screen.getByRole('status', { name: 'Codex is waiting on you' });
  assert.match(banner.textContent ?? '', /Codex is asking you/);
  assert.equal(within(banner).getByText('Answer in Codex').getAttribute('href'), link.app);
  assert.equal(within(banner).queryByText('web'), null, 'a local Codex thread has no web address');
  assert.match(document.querySelector('.head-status')?.textContent ?? '', /Codex is waiting on you/);
  assert.match(document.title, /Codex is waiting/);
  assert.doesNotMatch(document.querySelector('.head')?.textContent ?? '', /Claude/);
});

test('a Cursor chat has no link, so the banner says to answer in the chat that asked', async () => {
  await boot(makeSession(makePlan(), { agent: 'cursor', surface: 'desktop', waiting: { kind: 'input', text: 'Per tenant?', since: Date.now() } }));
  const banner = screen.getByRole('status', { name: 'Cursor is waiting on you' });
  assert.match(banner.textContent ?? '', /Cursor chat that asked/);
  assert.doesNotMatch(banner.textContent ?? '', /remote-control/, 'Remote Control is a Claude Code feature');
  assert.ok(within(banner).getByText('Copy message for Cursor'));
});

test('in Cursor, submitting copies the prompt to paste, since no hook can hand it over', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  const session = makeSession(confirmedPlan(), { agent: 'cursor' });
  const version = session.plan!.version;
  await boot(session, (route) => {
    if (route.endsWith('/plan/prompt')) return { prompt: 'THE CURSOR PROMPT', trimmed: false, version, budget: 9000, maxNote: 4000 };
    if (route.endsWith('/plan/submit')) return { plan: lockedPlan() };
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review & submit plan' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Submit the plan' });
  assert.ok(within(dialog).getByLabelText(/^Tracked — Cursor builds it here/));
  assert.match(dialog.textContent ?? '', /copied for you to paste into this Cursor chat/);
  const submit = within(dialog).getByRole('button', { name: 'Copy, submit and lock' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(submit.disabled, false));
  await act(async () => {
    fireEvent.click(submit);
  });
  assert.equal(copied, 'THE CURSOR PROMPT');
  assert.ok(store.getState().toasts.some((t) => /Paste the prompt into Cursor's chat/.test(t.text)));
});

test('in Cursor, confirming the design copies its prompt to paste, and the strip says so', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  const session = makeSession(makePlan(), { agent: 'cursor' });
  const version = session.plan!.version;
  await boot(session, (route) => {
    if (route.endsWith('/plan/design/prompt')) return { prompt: 'THE DESIGN PROMPT', trimmed: false, version, budget: 9000, maxNote: 4000 };
    if (route.endsWith('/plan/design/confirm')) return { plan: confirmedPlan() };
    return undefined;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm design' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Confirm the design' });
  assert.match(dialog.textContent ?? '', /You paste it into Cursor's chat/);
  const confirm = within(dialog).getByRole('button', { name: 'Copy and confirm design' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(confirm.disabled, false));
  await act(async () => {
    fireEvent.click(confirm);
  });
  assert.equal(copied, 'THE DESIGN PROMPT');
  const strip = screen.getByRole('region', { name: 'The design' });
  assert.match(strip.textContent ?? '', /Paste the prompt into Cursor's chat/);
  assert.match(strip.textContent ?? '', /harness_plan_read/);
});

test('the session rail names each row\'s agent once there is more than one kind', async () => {
  const row = (sessionId: string, agent: SessionState['agent']) => ({
    sessionId, agent, title: sessionId, planTitle: null, cwd: '/repo', repoName: 'repo', repoRoot: '/repo', branch: 'main',
    status: 'idle' as const, createdAt: 1, updatedAt: 1, tasks: { total: 0, done: 0, inProgress: 0, blocked: 0 }, phase: 'planning' as const,
    current: null, waiting: null, surface: 'unknown' as const, link: null, openThreads: 0, unreadByClaude: 0, engaged: true,
  });
  await boot(makeSession(), (route) => (route.startsWith('/api/sessions') ? { sessions: [row('s1', 'claude'), row('s2', 'codex')], version: 'test' } : undefined));
  const rail = screen.getByRole('navigation', { name: 'Live sessions' });
  assert.ok(within(rail).getByText('Codex'));
  assert.ok(within(rail).getByText('Claude'));
});

/* ------------------------------------------------------------ proposals */

function proposed(): Plan {
  return applyOps(
    makePlan(),
    [
      {
        op: 'propose',
        title: 'Put Redis in front of Postgres',
        reason: 'Reads are slow, and **most are repeats**.',
        ops: [
          { op: 'upsert_node', diagramId: 'd1', id: 'cache', label: 'Redis', kind: 'datastore' },
          { op: 'upsert_node', diagramId: 'd1', id: 'db', description: 'Only on a miss.' },
        ],
      },
    ],
    'claude',
  ).plan;
}

test("the agent's proposal waits beside the plan, with its reason and what it changes, until the user answers", async () => {
  await boot(makeSession(proposed()));
  const card = screen.getByRole('article', { name: 'Put Redis in front of Postgres' });
  assert.match(card.textContent ?? '', /Claude proposes/);
  assert.match(card.textContent ?? '', /most are repeats/);
  assert.match(card.textContent ?? '', /2 changes/);
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'accept_proposal', id: 'p1' });
});

test('rejecting a proposal sends the reason, if the user gives one', async () => {
  await boot(makeSession(proposed()));
  const card = screen.getByRole('article', { name: 'Put Redis in front of Postgres' });
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Reject…' }));
  });
  await act(async () => {
    fireEvent.change(within(card).getByLabelText(/Why not\?/), { target: { value: 'Not yet.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'reject_proposal', id: 'p1', note: 'Not yet.' });
});

test('a proposal shown on the canvas marks what it adds and changes, and saves nothing', async () => {
  await boot(makeSession(proposed()));
  const card = screen.getByRole('article', { name: 'Put Redis in front of Postgres' });
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Show on canvas' }));
  });
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node.diff-added')));
  const node = (label: string) => [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find((n) => n.querySelector('.flow-node-label')?.textContent === label);
  assert.ok(node('Redis')?.classList.contains('diff-added'), 'the new box');
  assert.ok(node('Postgres')?.classList.contains('diff-changed'), 'the box it describes');
  assert.ok(!node('API')?.className.includes('diff-'), 'the rest as they are');
  assert.ok(screen.getAllByRole('status').some((s) => /Previewing p1: the plan as it would be/.test(s.textContent ?? '')));
  assert.equal(opsSent().length, 0, 'a preview saves nothing');
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Close preview' })[0]!);
  });
  assert.equal(document.querySelector('.react-flow__node.diff-added'), null);
});

test('a proposal the plan has moved past cannot be accepted, and says what moved', async () => {
  const plan = applyOps(proposed(), [{ op: 'upsert_node', diagramId: 'd1', id: 'api', label: 'Gateway' }], 'user').plan;
  await boot(makeSession(plan));
  const card = screen.getByRole('article', { name: 'Put Redis in front of Postgres' });
  assert.equal((within(card).getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled, true);
  assert.match(within(card).getByRole('note').textContent ?? '', /out of date: diagram "Components" changed since it was made/);
});

/* ------------------------------------------------------ Request revisions (#67) */

/** A plan with two comments waiting on the agent. */
function commentedPlan(): Plan {
  return applyOps(
    makePlan(),
    [
      { op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use a replica.' },
      { op: 'comment', target: { kind: 'section', id: 's1' }, text: 'Say how slow.' },
    ],
    'user',
  ).plan;
}

const REVISION = '[cc-harness] Revise the plan "Add a cache" — the user wants you to act on their open comments.\n\nTHE COMMENTS';

function revisionAnswers(plan: Plan) {
  return (route: string) =>
    route.endsWith('/plan/revisions/prompt')
      ? { prompt: REVISION, hash: 'h1', trimmed: false, version: plan.version, budget: 9000, maxNote: 4000, threadIds: plan.threads.map((t) => t.id) }
      : route.endsWith('/plan/revisions')
        ? { plan: queueRevision(plan, { prompt: REVISION, threadIds: plan.threads.map((t) => t.id) }) }
        : undefined;
}

test('Request revisions sends every comment waiting on the agent as one ask, queued for the next message (#67)', async () => {
  const plan = commentedPlan();
  await boot(makeSession(plan), revisionAnswers(plan));
  const button = screen.getByRole('button', { name: /^Request revisions/ });
  assert.match(button.textContent ?? '', /2$/, 'how many comments it carries');
  await act(async () => {
    fireEvent.click(button);
  });
  const dialog = screen.getByRole('dialog', { name: 'Request revisions' });
  await waitFor(() => assert.equal(within(dialog).getByTestId('revision-preview').textContent, REVISION));
  assert.match(dialog.textContent ?? '', /2 comments waiting on Claude/);
  assert.match(dialog.textContent ?? '', /box "Postgres"[^:]*: Use a replica\./);
  assert.match(dialog.textContent ?? '', /Coplan never starts a turn: the request goes with your next message in Claude's chat/);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Queue request' }));
  });
  const sent = posts.find((p) => p.route.endsWith('/plan/revisions'));
  assert.deepEqual(sent?.body, { note: '', expect: plan.version, hash: 'h1' });
  assert.equal(screen.queryByRole('dialog'), null);
  // Pending, until the agent has it: with a copy to paste, and a way to take it back.
  assert.equal(screen.getByTestId('revision-state').textContent, 'Revisions pending');
  assert.match(screen.getByTestId('revision-state').getAttribute('title') ?? '', /goes to Claude with your next message/);
  assert.ok(screen.getByRole('button', { name: 'Copy request' }));
  assert.ok(screen.getByRole('button', { name: 'Withdraw' }));
  assert.ok(screen.queryByRole('button', { name: /^Request revisions/ }) === null, 'one ask at a time');
});

test('a request shows as sent, with how many comments are answered, then as answered (#67)', async () => {
  const plan = commentedPlan();
  const [replica, slow] = plan.threads;
  let sent = markRevisionDelivered(queueRevision(plan, { prompt: REVISION, threadIds: [replica!.id, slow!.id] }));
  sent = applyOps(sent, [{ op: 'reply', threadId: slow!.id, text: 'Added the p99.' }], 'claude').plan;
  await boot(makeSession(sent));
  assert.equal(screen.getByTestId('revision-state').textContent, 'Revisions sent · 1/2');
  assert.match(screen.getByTestId('revision-state').getAttribute('title') ?? '', /1 of 2 comments answered so far/);
  // The comment still unanswered can be sent again, should the agent have let it drop.
  assert.match(screen.getByRole('button', { name: /^Request revisions/ }).textContent ?? '', /1$/);

  cleanup();
  const answered = applyOps(sent, [{ op: 'resolve', threadId: replica!.id, resolved: true }], 'claude').plan;
  await boot(makeSession(answered));
  assert.equal(screen.getByTestId('revision-state').textContent, 'Revisions answered');
  assert.ok(screen.queryByRole('button', { name: /^Request revisions/ }) === null, 'nothing waits on the agent now');
});

test('with a link, queuing opens the session where "Answer in" does; in Cursor the request is copied to paste (#67)', async () => {
  const plan = commentedPlan();
  await boot(makeSession(plan, { link: LINK }), revisionAnswers(plan));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Request revisions/ }));
  });
  let dialog = screen.getByRole('dialog', { name: 'Request revisions' });
  await waitFor(() => assert.equal(within(dialog).getByTestId('revision-preview').textContent, REVISION));
  assert.equal(within(dialog).getByText('Queue and open in Claude').closest('a')?.getAttribute('href'), LINK.app);

  cleanup();
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
  await boot(makeSession(plan, { agent: 'cursor' }), revisionAnswers(plan));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Request revisions/ }));
  });
  dialog = screen.getByRole('dialog', { name: 'Request revisions' });
  await waitFor(() => assert.equal(within(dialog).getByTestId('revision-preview').textContent, REVISION));
  assert.match(dialog.textContent ?? '', /paste it into Cursor's chat, or ask Cursor to read the plan/);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy and queue request' }));
  });
  assert.equal(copied, REVISION, 'Cursor cannot carry it with a message: it is pasted');
  assert.ok(posts.some((p) => p.route.endsWith('/plan/revisions')));
  assert.match(screen.getByTestId('revision-state').getAttribute('title') ?? '', /paste it into Cursor's chat/);
});

/* ------------------------------------------------------ Harness config errors (#52) */

test('what is wrong with the harness config is said in the page, once per problem (#52)', async () => {
  const problem = '/repo/.claude/harness.json: "autoOpen" must be true or false; "yes" is not, so false is used.';
  const session = makeSession();
  await boot(session, (route) => (route === '/api/session/s1' ? { session, configErrors: [problem] } : undefined));
  const said = () => store.getState().toasts.filter((t) => t.text.includes('"autoOpen" must be true or false'));
  await waitFor(() => assert.equal(said().length, 1));
  assert.equal(said()[0]!.kind, 'error');
  assert.match(said()[0]!.text, /^Coplan's config: .*Run coplan doctor to see every problem\.$/);
  // Loaded again (the live stream reconnecting, the session picked again): not said twice.
  await act(async () => {
    await store.selectSession('s1');
  });
  assert.equal(said().length, 1);
});

/* ------------------------------------------------------ A task's own checks (#54) */

const CHECKS = { implement: ['typecheck'], review: ['tests'] };

test("a task's checks are set in its details: untick one to skip it, or add one of its own (#54)", async () => {
  const plan = confirmedPlan();
  const session = makeSession(plan);
  await boot(session, (route) => (route === '/api/session/s1' ? { session, projectChecks: CHECKS } : undefined));
  await openTab('Tasks');
  const row = document.getElementById('task-t3')!;
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: 'Details of Wire into API' }));
  });
  const repo = screen.getByRole('list', { name: "The repository's checks for Wire into API" });
  assert.deepEqual(within(repo).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked), [true, true], 'every check runs until one is skipped');
  await act(async () => {
    fireEvent.click(within(repo).getByLabelText(/^tests/));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'set_checks', id: 't3', skip: ['tests'] });

  const form = screen.getByRole('group', { name: 'Add a check for this task' });
  await act(async () => {
    fireEvent.change(within(form).getByLabelText('Command of the check to add'), { target: { value: 'pnpm db:check' } });
    fireEvent.change(within(form).getByLabelText('Name of the check to add'), { target: { value: 'db:check' } });
  });
  await act(async () => {
    fireEvent.click(within(form).getByRole('button', { name: 'Add check' }));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'set_checks', id: 't3', add: [{ name: 'db:check', run: 'pnpm db:check', stage: 'review' }] });
  assert.match(screen.getByText(/Only you set these; Claude proposes changes to them/).textContent ?? '', /an added one gates/);
});

test('a skipped check shows on the task, on its card mid-build — where the user can still set it — and in the report (#54)', async () => {
  let plan = applyOps(confirmedPlan(), [{ op: 'set_checks', id: 't3', skip: ['tests'], add: [{ name: 'db:check', run: 'pnpm db:check' }] }], 'user').plan;
  await boot(makeSession(plan));
  await openTab('Tasks');
  const row = document.getElementById('task-t3')!;
  assert.match(row.textContent ?? '', /skips tests/);
  assert.match(row.textContent ?? '', /＋ db:check/);

  cleanup();
  plan = markDelivered(submitPlan(plan, { target: 'session', prompt: 'P' }));
  const session = makeSession(plan);
  await boot(session, (route) => (route === '/api/session/s1' ? { session, projectChecks: CHECKS } : undefined));
  await openTab('Tasks');
  const card = document.getElementById('task-t3')!;
  assert.match(card.textContent ?? '', /skips tests/);
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Wire into API' }));
  });
  await act(async () => {
    fireEvent.click(within(card).getByLabelText(/^tests/));
  });
  assert.deepEqual(opsSent().at(-1), { op: 'set_checks', id: 't3', skip: [] }, 'the user takes the skip back mid-build');

  cleanup();
  for (const t of plan.tasks.filter((x) => !plan.tasks.some((c) => c.parentId === x.id))) {
    plan = applyOps(plan, [{ op: 'upsert_task', id: t.id, status: 'done' }], 'claude', undefined, { tracking: true }).plan;
  }
  plan = applyOps(plan, [{ op: 'report', text: 'Built it.' }], 'claude').plan;
  await boot(makeSession(plan));
  await openTab('Overview');
  assert.match(screen.getByTestId('skipped-checks').textContent ?? '', /Checks you skipped: t3 Wire into API \(tests\)\./);
});
