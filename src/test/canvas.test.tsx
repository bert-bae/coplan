import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { GapSeverities } from '../shared/check.ts';
import type { Plan, PlanOp, SessionState } from '../shared/types.ts';

/**
 * Editing on the canvas, end to end in a browser: shortcuts, menus,
 * undo, and what lights up. Every edit is checked by the op it sends.
 * (Arrows are not drawn here — jsdom measures nothing — so grips and
 * dropping onto an arrow are exercised in a real browser instead.)
 */

setupDom();

const { render, fireEvent, within, cleanup, act, screen, waitFor } = await import('@testing-library/react');
const { App } = await import('../ui/App.tsx');
const { store } = await import('../ui/store.ts');
const { publishPlan, applyOps, confirmDesign, submitPlan } = await import('../shared/plan.ts');

/** user → gw → api → db, api → cache */
function makePlan(): Plan {
  return publishPlan(
    null,
    {
      title: 'Orders',
      diagrams: [
        {
          title: 'Components',
          direction: 'LR',
          nodes: [
            { id: 'user', label: 'Customer', kind: 'actor' },
            { id: 'gw', label: 'Gateway', kind: 'service' },
            { id: 'api', label: 'API', kind: 'service' },
            { id: 'db', label: 'Postgres', kind: 'datastore' },
            { id: 'cache', label: 'Redis', kind: 'datastore' },
          ],
          edges: [
            { source: 'user', target: 'gw' },
            { source: 'gw', target: 'api', label: 'REST' },
            { source: 'api', target: 'db', label: 'SQL' },
            { source: 'api', target: 'cache' },
          ],
        },
      ],
    },
    Date.now(),
  ).plan;
}

function makeSession(plan: Plan = makePlan()): SessionState {
  const now = Date.now();
  return { sessionId: 's1', agent: 'claude', cwd: '/repo', repoRoot: '/repo', branch: 'main', title: 'repo', status: 'idle', waiting: null, surface: 'unknown', link: null, createdAt: now, updatedAt: now, plan };
}

/** The same diagram with a note on it, and two tasks: one builds the API,
 *  the other — with a subtask — builds Postgres. */
function taskedPlan(): Plan {
  const plan = makePlan();
  plan.diagrams[0]!.nodes.push({ id: 'memo', label: 'Why Redis', kind: 'note' });
  return applyOps(
    plan,
    [
      { op: 'upsert_task', id: 'routes', title: 'Add the routes', builds: ['api'] },
      { op: 'upsert_task', id: 'schema', title: 'Write the schema', builds: ['db'] },
      { op: 'upsert_task', id: 'migrate', parentId: 'schema', title: 'Migrate the data' },
    ],
    'user',
  ).plan;
}

let posts: { route: string; body: Record<string, unknown> }[];
/** Set to refuse the next save, as the daemon does an invalid one. */
let refuseNext = false;
/** While set, every batch is applied to this plan and answered with it, as
 *  the daemon does; otherwise a save is answered with the plan as it was. */
let live: Plan | null = null;

async function boot(session: SessionState = makeSession(), opts: { live?: boolean; planCheck?: GapSeverities } = {}): Promise<void> {
  refuseNext = false;
  live = opts.live ? session.plan : null;
  ({ posts } = stubFetch((route, init) => {
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    if (route.endsWith('/plan/ops') && refuseNext) {
      refuseNext = false;
      return { __status: 400, error: 'refused' };
    }
    if (route.endsWith('/plan/ops') && live) {
      try {
        live = applyOps(live, (JSON.parse(String(init?.body)) as { ops: PlanOp[] }).ops, 'user').plan;
        return { plan: live, changes: [] };
      } catch (err) {
        return { __status: 400, error: (err as Error).message };
      }
    }
    if (route.endsWith('/plan/ops')) return { plan: store.getState().session?.plan, changes: [] };
    if (route.includes('/brief')) return { text: 'THE BRIEF', blocks: [], task: { id: 'routes', title: 'Add the routes' }, version: 1 };
    if (route.startsWith('/api/session/')) return { session, ...(opts.planCheck ? { planCheck: opts.planCheck } : {}) };
    return { ok: true };
  }));
  render(<App />);
  await act(async () => {
    await store.init();
  });
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node')));
}

/** The graph in the last save. */
const lastGraph = () => {
  const op = posts
    .filter((p) => p.route.endsWith('/plan/ops'))
    .flatMap((p) => p.body['ops'] as Record<string, unknown>[])
    .filter((o) => o['op'] === 'upsert_diagram')
    .at(-1);
  assert.ok(op, 'a save was sent');
  return { nodes: op['nodes'] as Record<string, unknown>[], edges: op['edges'] as Record<string, unknown>[] };
};
const saves = () => posts.filter((p) => p.route.endsWith('/plan/ops')).length;
const opsSent = () => posts.filter((p) => p.route.endsWith('/plan/ops')).flatMap((p) => p.body['ops'] as Record<string, unknown>[]);
const ends = (g = lastGraph()) => g.edges.map((e) => `${e['source']}->${e['target']}`).sort();

const nodeEl = (label: string) => [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find((n) => n.querySelector('.flow-node-label')?.textContent === label)!;
const selectBox = async (label: string) => {
  await act(async () => {
    fireEvent.click(nodeEl(label));
  });
};
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });
};
/** A box's task chip. Found by its name: React Flow keeps boxes jsdom cannot
 *  measure hidden, so they are not in the accessibility tree. */
const chipOf = (label: string) => document.querySelector<HTMLButtonElement>(`button.flow-task-chip[aria-label^="Tasks for ${label}:"]`);
const taskList = () => document.querySelector<HTMLElement>('.flow-tasks[role="dialog"]');
const openTasks = async (label: string) => {
  await act(async () => {
    fireEvent.click(chipOf(label)!);
  });
  const list = taskList();
  assert.ok(list, 'the task list is open');
  return list;
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store.set({ sessions: [], sessionId: null, session: null, planCheck: {}, tab: 'diagrams', diagramId: null, toasts: [], focusTarget: null, collapsedSidebar: false, viewer: null, taskMode: 'outline' });
});

after(() => cleanup());

/* --------------------------------------------------------------- adding */

test('Tab adds a box after the selected one, connected, and starts naming it', async () => {
  await boot();
  await selectBox('API');
  await press('Tab');
  const g = lastGraph();
  const made = g.nodes.find((n) => !['user', 'gw', 'api', 'db', 'cache'].includes(n['id'] as string))!;
  assert.ok(made, 'a new box');
  assert.ok(ends(g).includes(`api->${made['id']}`), 'connected from the selected box');
  assert.ok(document.querySelector('.flow-node-input'), 'named in place');
});

test('Tab, a name, Tab again: a chain built without leaving the keyboard', async () => {
  await boot();
  await selectBox('Postgres');
  await press('Tab');
  let input = document.querySelector<HTMLInputElement>('.flow-node-input')!;
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Replica' } });
    fireEvent.keyDown(input, { key: 'Tab' });
  });
  assert.equal(document.querySelector('.flow-node-input'), null, 'Tab finished the name');
  await press('Tab');
  input = document.querySelector<HTMLInputElement>('.flow-node-input')!;
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Backup' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  const g = lastGraph();
  const id = (label: string) => g.nodes.find((n) => n['label'] === label)?.['id'];
  assert.ok(ends(g).includes(`db->${id('Replica')}`));
  assert.ok(ends(g).includes(`${id('Replica')}->${id('Backup')}`), 'the second box follows the first');
});

test('Shift+Tab adds one before it, and Enter one beside it fed by the same boxes', async () => {
  await boot();
  await selectBox('API');
  await press('Tab', { shiftKey: true });
  let g = lastGraph();
  const before = g.nodes.at(-1)!['id'] as string;
  assert.ok(ends(g).includes(`${before}->api`));

  await act(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await selectBox('Postgres');
  await press('Enter');
  g = lastGraph();
  const beside = g.nodes.at(-1)!;
  assert.equal(beside['kind'], 'datastore', 'the same kind as its neighbour');
  assert.ok(ends(g).includes(`api->${beside['id']}`), 'fed by Postgres’s parent');
});

test('on a toolbar button, Tab, Enter and typing are the button’s, even with a box selected', async () => {
  await boot();
  await selectBox('API');
  const tidy = screen.getByRole('button', { name: 'Tidy layout' });
  await act(async () => {
    tidy.focus();
  });
  const before = saves();
  await press('Tab');
  await press('Enter');
  await press('x');
  await settle();
  assert.equal(saves(), before, 'no box was added or renamed');
  assert.equal(document.querySelector('.flow-node-input'), null);
});

test('F6 moves the keyboard to the details panel and back to the selected box', async () => {
  await boot();
  await selectBox('API');
  await act(async () => {
    nodeEl('API').focus();
  });
  await press('F6');
  const panel = screen.getByRole('complementary', { name: 'Details' });
  assert.ok(panel.contains(document.activeElement), 'in the details panel');
  await press('F6');
  assert.equal(document.activeElement, nodeEl('API'), 'back on the box that was selected');
});

test('right-clicking empty canvas offers a box of any kind, right there', async () => {
  await boot();
  await act(async () => {
    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 300, clientY: 200 });
  });
  const menu = screen.getByRole('menu', { name: 'Canvas' });
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Queue' }));
  });
  assert.equal(lastGraph().nodes.at(-1)!['kind'], 'queue');
  assert.equal(screen.queryByRole('menu'), null, 'and the menu closes');
});

test("a box's menu does what its shortcuts do, and names them", async () => {
  await boot();
  await act(async () => {
    fireEvent.contextMenu(nodeEl('Redis'), { clientX: 300, clientY: 200 });
  });
  const menu = screen.getByRole('menu', { name: 'Redis' });
  assert.match(menu.textContent ?? '', /Add a box after itTab/);
  assert.match(menu.textContent ?? '', /Delete, keeping the flow/);
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Connect to/ }));
  });
  await act(async () => {
    fireEvent.click(within(screen.getByRole('menu', { name: 'Connect to' })).getByRole('menuitem', { name: 'Customer' }));
  });
  assert.ok(ends().includes('cache->user'));
});

test('the menu works from the keyboard: Shift+F10 opens it, arrows move, Escape closes', async () => {
  await boot();
  await selectBox('Gateway');
  await press('F10', { shiftKey: true });
  const menu = screen.getByRole('menu', { name: 'Gateway' });
  assert.equal(document.activeElement?.textContent, 'RenameF2', 'the first item has focus');
  await act(async () => {
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
  });
  assert.equal(document.activeElement?.getAttribute('role'), 'menuitemradio', 'the kind choices are next');
  await act(async () => {
    fireEvent.keyDown(menu, { key: 'Escape' });
  });
  assert.equal(screen.queryByRole('menu'), null);
});

/* -------------------------------------------------------------- editing */

test('typing on a selected box renames it, from the key typed — even a digit the app would use', async () => {
  await boot();
  await selectBox('API');
  await press('2');
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.flow-node-input');
    assert.ok(el);
    return el;
  });
  assert.equal(input.value, '2', 'typed over the old name');
  assert.equal(store.getState().tab, 'diagrams', '"2" did not switch to the Tasks tab');
  await act(async () => {
    fireEvent.change(input, { target: { value: '2nd API' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  assert.equal(lastGraph().nodes.find((n) => n['id'] === 'api')!['label'], '2nd API');
});

test('with nothing selected, the app keeps its own keys', async () => {
  await boot();
  await press('2');
  assert.equal(store.getState().tab, 'tasks');
});

test('Alt+Backspace deletes a box and joins the flow around it', async () => {
  await boot();
  await selectBox('Gateway');
  await press('Backspace', { altKey: true });
  const g = lastGraph();
  assert.ok(!g.nodes.some((n) => n['id'] === 'gw'));
  assert.deepEqual(ends(g), ['api->cache', 'api->db', 'user->api']);
});

/* ---------------------------------------------------------------- undo */

test('undo puts back the graph before the last edit, and redo puts it forward again', async () => {
  await boot();
  await selectBox('Gateway');
  await press('Backspace', { altKey: true });
  assert.ok(!lastGraph().nodes.some((n) => n['id'] === 'gw'));
  await press('z', { ctrlKey: true });
  await settle();
  assert.ok(lastGraph().nodes.some((n) => n['id'] === 'gw'), 'the box is back');
  assert.deepEqual(ends(), ['api->cache', 'api->db', 'gw->api', 'user->gw'], 'and its arrows');
  await press('z', { ctrlKey: true, shiftKey: true });
  await settle();
  assert.ok(!lastGraph().nodes.some((n) => n['id'] === 'gw'), 'redone');
});

test('undo is a toolbar button too, disabled until there is something to undo', async () => {
  await boot();
  const undo = screen.getByRole('button', { name: 'Undo', hidden: true }) as HTMLButtonElement;
  assert.equal(undo.disabled, true);
  await selectBox('API');
  await press('Tab');
  assert.equal(undo.disabled, false);
});

test('a refused save — even an undo — leaves no history that no longer matches what is saved', async () => {
  await boot();
  await selectBox('API');
  await press('Tab');
  await press('Escape');
  await selectBox('Postgres');
  await press('Tab');
  await press('Escape');
  await settle();
  await act(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  refuseNext = true;
  await press('z', { ctrlKey: true });
  await settle();
  const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
  const redo = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
  assert.equal(undo.disabled, true, 'nothing left to undo to');
  assert.equal(redo.disabled, true, 'and no refused graph to redo');
});

test('a title edited beside the canvas while a move waits to save neither refuses the move nor costs its undo', async () => {
  await boot(makeSession(), { live: true });
  const id = live!.diagrams[0]!.id;
  await selectBox('API');
  const moved = () => live!.diagrams[0]!.nodes.find((n) => n.label === 'API')!;
  const x = moved().x;
  await act(async () => {
    fireEvent.keyDown(nodeEl('API'), { key: 'ArrowRight' });
  });
  // While the move waits, the title changes: Claude, or the panel beside the canvas.
  live = applyOps(live!, [{ op: 'upsert_diagram', id, title: 'Renamed mid-move' }], 'claude').plan;
  const s = store.getState().session!;
  await act(async () => {
    store.apply({ type: 'snapshot', session: { ...s, plan: live! } });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  await settle();
  assert.notEqual(moved().x, x, 'the move was saved');
  assert.equal(live!.diagrams[0]!.title, 'Renamed mid-move', 'over the new title, not instead of it');
  assert.equal((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled, false, 'and it can be undone');
  assert.doesNotMatch(store.getState().toasts.at(-1)?.text ?? '', /was changed by/);

  // A box added meanwhile is a change to the graph: that move is refused, not saved over it.
  await act(async () => {
    fireEvent.keyDown(nodeEl('API'), { key: 'ArrowRight' });
  });
  const graph = live!.diagrams[0]!;
  live = applyOps(live!, [{ op: 'upsert_diagram', id, nodes: [...graph.nodes, { id: 'queue', label: 'Queue', kind: 'queue' }], edges: graph.edges }], 'claude').plan;
  await act(async () => {
    store.apply({ type: 'snapshot', session: { ...store.getState().session!, plan: live! } });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  await settle();
  assert.ok(live!.diagrams[0]!.nodes.some((n) => n.id === 'queue'), "Claude's box stays");
  assert.match(store.getState().toasts.at(-1)?.text ?? '', /was changed by Claude/);
});

test('undo will not revert a change made elsewhere, and says so', async () => {
  await boot();
  await selectBox('API');
  await press('Tab');
  const before = saves();
  // Claude adds a box to the diagram meanwhile.
  const s = store.getState().session!;
  const plan = structuredClone(s.plan!);
  plan.diagrams[0]!.nodes.push({ id: 'claude', label: 'Added by Claude', kind: 'service' });
  plan.diagrams[0]!.rev += 7;
  plan.version += 1;
  await act(async () => {
    store.apply({ type: 'snapshot', session: { ...s, plan } });
  });
  await settle();
  await act(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await press('z', { ctrlKey: true });
  assert.equal(saves(), before, 'nothing was sent');
  assert.match(store.getState().toasts.at(-1)?.text ?? '', /changed elsewhere/);
});

/* ---------------------------------------------------------- relationships */

test('selecting a box lights up what it connects to by direction, and fades the rest', async () => {
  await boot();
  await selectBox('API');
  await waitFor(() => assert.ok(document.querySelector('.react-flow__node.rel-focus, .flow-node.rel-focus')));
  const rel = (label: string) => nodeEl(label).querySelector('.flow-node-rel')?.textContent ?? null;
  assert.equal(rel('Gateway'), 'from →');
  assert.equal(rel('Postgres'), '→ to');
  assert.equal(rel('Redis'), '→ to');
  assert.ok(nodeEl('Customer').classList.contains('rel-dim'), 'two steps away fades');
  assert.match(document.querySelector('.flow-legend')?.textContent ?? '', /from →API→ to/);
});

test('holding Alt reaches two steps out', async () => {
  await boot();
  await selectBox('API');
  await act(async () => {
    fireEvent.keyDown(document.body, { key: 'Alt', altKey: true });
  });
  await waitFor(() => assert.equal(nodeEl('Customer').querySelector('.flow-node-rel')?.textContent, 'before →'));
  await act(async () => {
    fireEvent.keyUp(document.body, { key: 'Alt' });
  });
  await waitFor(() => assert.ok(nodeEl('Customer').classList.contains('rel-dim')));
});

test('hovering previews a box’s relationships without selecting it', async () => {
  await boot();
  await act(async () => {
    fireEvent.mouseEnter(nodeEl('Gateway'));
  });
  await waitFor(() => assert.equal(nodeEl('Customer').querySelector('.flow-node-rel')?.textContent, 'from →'));
  assert.equal(document.querySelectorAll('.react-flow__node.selected').length, 0);
});

/* ---------------------------------------------------------------- view */

test('? shows every shortcut, and Escape puts it away', async () => {
  await boot();
  await press('?');
  const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  assert.match(sheet.textContent ?? '', /Tab.*a box after the selected one/);
  assert.match(sheet.textContent ?? '', /delete, keeping the flow through it/);
  await act(async () => {
    fireEvent.keyDown(sheet, { key: 'Escape' });
  });
  assert.equal(screen.queryByRole('dialog'), null);
});

/* ------------------------------------------------------- tasks on a box */

test('every box but a note counts the tasks that build it, even none', async () => {
  await boot(makeSession(taskedPlan()));
  assert.equal(chipOf('API')?.textContent, '☐0/1');
  assert.equal(chipOf('API')?.getAttribute('aria-label'), 'Tasks for API: 0 of 1 done');
  assert.equal(chipOf('Postgres')?.getAttribute('aria-label'), 'Tasks for Postgres: 0 of 1 done', 'a parent counts as its subtasks');
  assert.equal(chipOf('Gateway')?.textContent, '☐0');
  assert.equal(chipOf('Gateway')?.getAttribute('aria-label'), 'Tasks for Gateway: no tasks yet');
  assert.ok(chipOf('Customer'), 'an actor has one too: a task can build what talks to it');
  assert.ok(!chipOf('Why Redis'), 'a note is not a part of the system');
});

test('a box no task builds says so, as the plan check would — and not for an actor or a note', async () => {
  await boot(makeSession(taskedPlan()));
  const gap = (label: string) => nodeEl(label).querySelector('.flow-node-gap')?.textContent ?? null;
  assert.equal(gap('Gateway'), 'no task');
  assert.equal(gap('Redis'), 'no task');
  assert.equal(gap('API'), null);
  assert.equal(gap('Customer'), null);
  assert.equal(gap('Why Redis'), null);
});

test('with no tasks in the plan yet, or the rule turned off in planCheck, no box is marked', async () => {
  await boot();
  assert.equal(chipOf('Gateway')?.textContent, '☐0');
  assert.ok(!document.querySelector('.flow-node-gap'), 'nothing is built by tasks yet');
  cleanup();
  await boot(makeSession(taskedPlan()), { planCheck: { 'box-unbuilt': 'off' } });
  await waitFor(() => assert.equal(store.getState().planCheck['box-unbuilt'], 'off'));
  assert.ok(!document.querySelector('.flow-node-gap'), 'the repository turned it off');
});

test("a box's chip opens its tasks, ready to add one; a task added there builds the box", async () => {
  await boot(makeSession(taskedPlan()), { live: true });
  const list = await openTasks('Gateway');
  assert.equal(list.getAttribute('aria-label'), 'Tasks for Gateway');
  assert.equal(chipOf('Gateway')?.getAttribute('aria-expanded'), 'true');
  assert.match(list.textContent ?? '', /No task builds this box yet/);
  const field = within(list).getByRole('textbox', { name: 'New task for Gateway' });
  assert.ok(document.activeElement === field, 'the keyboard is on the field to add one');
  await act(async () => {
    fireEvent.change(field, { target: { value: 'Rate limits' } });
    fireEvent.submit(field.closest('form')!);
  });
  await settle();
  assert.deepEqual(opsSent().at(-1), { op: 'upsert_task', title: 'Rate limits', builds: ['d1/gw'] });
  await waitFor(() => assert.equal(chipOf('Gateway')?.getAttribute('aria-label'), 'Tasks for Gateway: 0 of 1 done'));
  assert.match(taskList()?.textContent ?? '', /Rate limits/, 'listed on the box');
  assert.equal(nodeEl('Gateway').querySelector('.flow-node-gap'), null, 'and no longer a gap');
  const made = live!.tasks.find((t) => t.title === 'Rate limits')!;
  assert.deepEqual(live!.diagrams[0]!.nodes.find((n) => n.id === 'gw')!.taskIds, [made.id], 'linked on the plan itself');
});

test("a box's tasks are renamed and unlinked in its list, and each opens its brief", async () => {
  await boot(makeSession(taskedPlan()));
  let list = await openTasks('Postgres');
  const rows = [...list.querySelectorAll('.flow-tasks-row')].map((r) => r.textContent);
  assert.equal(rows.length, 2, 'the task, and its subtask under it');
  assert.match(rows[1] ?? '', /Migrate the data/);
  assert.ok(!within(list).queryByRole('button', { name: 'Unlink Migrate the data from Postgres' }), 'a subtask builds it through its parent');

  await act(async () => {
    fireEvent.click(within(list).getByRole('button', { name: /^Title of task 2: Write the schema/ }));
  });
  const title = within(list).getByRole('textbox', { name: 'Title of task 2' });
  await act(async () => {
    fireEvent.change(title, { target: { value: 'Write the schema, with indexes' } });
    fireEvent.keyDown(title, { key: 'Enter' });
  });
  assert.deepEqual(opsSent().at(-1), { op: 'upsert_task', id: 'schema', title: 'Write the schema, with indexes', expect: 1 });
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Title of task 2: Write the schema. Edit', 'the keyboard stays on the title');

  await act(async () => {
    fireEvent.click(within(list).getByRole('button', { name: 'Unlink Write the schema from Postgres' }));
  });
  const db = lastGraph().nodes.find((n) => n['id'] === 'db')!;
  assert.deepEqual(db['taskIds'], [], 'unlinked as the panel does, on the canvas');
  assert.ok(taskList(), 'the list stays open');

  list = await openTasks('API');
  await act(async () => {
    fireEvent.click(within(list).getByRole('button', { name: 'Brief for Add the routes' }));
  });
  assert.deepEqual(store.getState().viewer, { tab: 'brief', taskId: 'routes' });
  assert.ok(!taskList(), 'the list makes way for the viewer');
  await waitFor(() => assert.ok(screen.getByRole('dialog', { name: 'What Claude reads' })));
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  });
  assert.equal(store.getState().viewer, null);
  assert.ok(document.activeElement === chipOf('API'), 'closing the brief goes back to the chip');
});

test('adding a task from a box is not a drawing edit: undo keeps the link, and the history stands', async () => {
  await boot(makeSession(taskedPlan()), { live: true });
  await selectBox('Gateway');
  await press('E');
  const input = document.querySelector<HTMLInputElement>('.flow-node-input')!;
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Edge' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  await settle();
  const list = await openTasks('Edge');
  await act(async () => {
    const field = within(list).getByRole('textbox', { name: 'New task for Edge' });
    fireEvent.change(field, { target: { value: 'TLS' } });
    fireEvent.submit(field.closest('form')!);
  });
  await settle();
  const tls = live!.tasks.find((t) => t.title === 'TLS')!.id;
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  });
  assert.ok(!taskList());
  await press('z', { ctrlKey: true });
  await settle();
  const gw = lastGraph().nodes.find((n) => n['id'] === 'gw')!;
  assert.equal(gw['label'], 'Gateway', 'the rename is undone');
  assert.deepEqual(gw['taskIds'], [tls], 'and the task added since is still linked');
  assert.doesNotMatch(store.getState().toasts.at(-1)?.text ?? '', /changed elsewhere/);
});

test('the chip is a control on the box: Tab, Enter and typing on it are its own (#30)', async () => {
  await boot(makeSession(taskedPlan()));
  await selectBox('API');
  const chip = chipOf('API')!;
  assert.equal(chip.tabIndex, 0, 'reached with Tab, like any button');
  await act(async () => {
    chip.focus();
  });
  const before = saves();
  await press('Tab');
  await press('Enter');
  await press('x');
  await press('Backspace');
  await settle();
  assert.equal(saves(), before, 'no box was added, renamed or deleted');
  assert.ok(!document.querySelector('.flow-node-input'));
  assert.ok(nodeEl('API'), 'the box is still there');
});

test('Alt+Enter opens the selected box’s tasks; Escape puts them away, back on the chip, with the box still selected', async () => {
  await boot(makeSession(taskedPlan()));
  await selectBox('API');
  await act(async () => {
    nodeEl('API').focus();
  });
  await press('Enter', { altKey: true });
  const list = taskList()!;
  assert.ok(list, 'opened from the keyboard');
  assert.equal(saves(), 0, 'and no box was added beside it');
  assert.ok(list.contains(document.activeElement));
  await press('Escape');
  assert.ok(!taskList());
  assert.ok(document.activeElement === chipOf('API'));
  assert.ok(nodeEl('API').closest('.react-flow__node')?.classList.contains('selected'), 'Escape closed the list, not the selection');
});

test('keys in a box’s task list stay there: typing, Backspace, undo and Tab never reach the canvas', async () => {
  await boot(makeSession(taskedPlan()));
  await selectBox('API');
  const list = await openTasks('API');
  const field = within(list).getByRole('textbox', { name: 'New task for API' });
  await press('x');
  assert.ok(document.activeElement === field);
  assert.ok(!document.querySelector('.flow-node-input'), 'typing did not rename the box');
  const brief = within(list).getByRole('button', { name: 'Brief for Add the routes' });
  await act(async () => {
    brief.focus();
  });
  await press('Backspace');
  await press('Delete');
  await press('z', { ctrlKey: true });
  await press('Tab');
  await press('Enter', { altKey: true });
  await settle();
  assert.equal(saves(), 0, 'nothing was deleted, undone or added');
  assert.ok(nodeEl('API'));
});

test('the box’s menu opens its tasks too, and the shortcuts sheet says how', async () => {
  await boot(makeSession(taskedPlan()));
  await selectBox('Redis');
  await press('F10', { shiftKey: true });
  const menu = screen.getByRole('menu', { name: 'Redis' });
  assert.match(menu.textContent ?? '', /Tasks that build it…(⌥|Alt\+)Enter/);
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Tasks that build it/ }));
  });
  assert.equal(taskList()?.getAttribute('aria-label'), 'Tasks for Redis');
  await act(async () => {
    fireEvent.pointerDown(document.querySelector('.react-flow__pane')!);
  });
  assert.ok(!taskList(), 'a click elsewhere closes it');
  await press('?');
  assert.match(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent ?? '', /(⌥|Alt\+)Enterthe selected box’s tasks/);
});

test('once the design is confirmed, tasks are still added from a box; once submitted, its list only reads', async () => {
  await boot(makeSession(confirmDesign(taskedPlan(), { prompt: 'THE DESIGN' })), { live: true });
  let list = await openTasks('Redis');
  await act(async () => {
    const field = within(list).getByRole('textbox', { name: 'New task for Redis' });
    fireEvent.change(field, { target: { value: 'Cache keys' } });
    fireEvent.submit(field.closest('form')!);
  });
  await settle();
  assert.deepEqual(opsSent().at(-1), { op: 'upsert_task', title: 'Cache keys', builds: ['d1/cache'] });
  await waitFor(() => assert.equal(chipOf('Redis')?.getAttribute('aria-label'), 'Tasks for Redis: 0 of 1 done'));

  cleanup();
  const locked = submitPlan(confirmDesign(taskedPlan(), { prompt: 'THE DESIGN' }), { target: 'session', prompt: 'THE PROMPT' });
  await boot(makeSession(locked));
  assert.equal(chipOf('API')?.textContent, '☐0/1', 'counted during the build too');
  list = await openTasks('API');
  assert.match(list.textContent ?? '', /Add the routes/);
  assert.ok(within(list).getByRole('button', { name: 'Brief for Add the routes' }));
  assert.ok(!within(list).queryByRole('textbox'), 'nothing to add');
  assert.ok(!within(list).queryByRole('button', { name: /^Unlink/ }), 'or unlink');
  assert.ok(!within(list).queryByRole('button', { name: /^Title of task/ }), 'or rename');
});

/* The box panel's fields while the agent publishes: what the user is typing
 * stays theirs; a field they have not touched follows the plan. */

const { CommitField } = await import('../ui/components/flow/Panels.tsx');

for (const [name, multiline, tag] of [['a paragraph', true, 'textarea'], ['a line', false, 'input']] as const) {
  /** The field as the panel shows it; `accept` is what the plan takes of a save. */
  function mount(value: string, accept: (v: string) => boolean = () => true) {
    const commits: string[] = [];
    const field = (v: string) => <CommitField value={v} label="Box description" multiline={multiline} onCommit={(c: string) => accept(c) && commits.push(c)} />;
    const view = render(field(value));
    const box = view.container.querySelector(tag)! as HTMLInputElement | HTMLTextAreaElement;
    return { commits, box, push: (v: string) => act(async () => view.rerender(field(v))), warned: () => view.container.querySelector('[role="alert"]') !== null };
  }

  test(`${name}: a push from the agent never replaces what the user is typing, and says it came`, async () => {
    const { commits, box, push, warned } = mount('Old description');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Old description, and what the user is typing ' } });
    await push('The agent rewrote it');
    assert.equal(box.value, 'Old description, and what the user is typing ', 'the typing stays, to the last space');
    assert.ok(warned(), 'and the user is told the box changed');
    fireEvent.blur(box);
    assert.deepEqual(commits, ['Old description, and what the user is typing'], 'leaving saves it');
    cleanup();
  });

  test(`${name}: Escape takes the agent's newer text instead`, async () => {
    const { commits, box, push, warned } = mount('Old');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Mine' } });
    await push('The agent rewrote it');
    fireEvent.keyDown(box, { key: 'Escape' });
    assert.equal(box.value, 'The agent rewrote it');
    assert.equal(warned(), false);
    fireEvent.blur(box);
    assert.deepEqual(commits, [], 'nothing to save');
    cleanup();
  });

  test(`${name}: left and removed at once (a session switch), it is saved once`, async () => {
    const { commits, box } = mount('Old');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'New' } });
    await act(async () => {
      fireEvent.blur(box);
      cleanup();
    });
    assert.deepEqual(commits, ['New']);
  });

  if (!multiline) {
    test(`${name}: Enter saves it, and leaving after does not save it again, though the plan has not answered yet`, async () => {
      const { commits, box, push } = mount('Old');
      act(() => box.focus());
      fireEvent.change(box, { target: { value: 'New' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      assert.deepEqual(commits, ['New']);
      await push('Old');
      act(() => box.blur());
      assert.deepEqual(commits, ['New']);
      cleanup();
    });
  } else {
    test(`${name}: Enter is a new line; ⌘/Ctrl+Enter leaves it, and saves it once`, async () => {
      const { commits, box } = mount('Old');
      act(() => box.focus());
      fireEvent.change(box, { target: { value: 'New' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      assert.deepEqual(commits, [], 'a paragraph goes on');
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
      assert.notEqual(document.activeElement, box, 'it is left');
      assert.deepEqual(commits, ['New']);
      cleanup();
    });
  }

  test(`${name}: out of the field it follows the plan, also after a save the plan refused`, async () => {
    const { commits, box, push } = mount('First', (v) => v !== '');
    await push('Second, from the agent');
    assert.equal(box.value, 'Second, from the agent', 'untouched, it follows');
    // Cleared and left: the plan keeps its text, and so does the field.
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    assert.deepEqual(commits, []);
    assert.equal(box.value, 'Second, from the agent');
    await push('Third, from the agent');
    assert.equal(box.value, 'Third, from the agent', 'and it still follows');
    cleanup();
  });
}
