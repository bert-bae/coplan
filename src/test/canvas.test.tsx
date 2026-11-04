import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, stubFetch } from './dom-env.ts';
import type { Plan, SessionState } from '../shared/types.ts';

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
const { publishPlan } = await import('../shared/plan.ts');

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
  return { sessionId: 's1', cwd: '/repo', repoRoot: '/repo', branch: 'main', title: 'repo', status: 'idle', waiting: null, surface: 'unknown', link: null, createdAt: now, updatedAt: now, plan };
}

let posts: { route: string; body: Record<string, unknown> }[];

async function boot(session: SessionState = makeSession()): Promise<void> {
  ({ posts } = stubFetch((route) => {
    if (route.startsWith('/api/sessions')) return { sessions: [], version: 'test' };
    if (route.endsWith('/plan/ops')) return { plan: store.getState().session?.plan, changes: [] };
    if (route.startsWith('/api/session/')) return { session };
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
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store.set({ sessions: [], sessionId: null, session: null, tab: 'diagrams', diagramId: null, toasts: [], focusTarget: null, collapsedSidebar: false });
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
