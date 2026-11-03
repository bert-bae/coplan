import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, labelSize, nodeSize, resolveLayout, type Positions } from '../ui/lib/layout.ts';
import type { Diagram, DiagramEdge, DiagramNode } from '../shared/types.ts';

/** Automatic layout: Claude's diagrams arrive without coordinates, and must
 *  open organised — in ranks along the flow, nothing overlapping. */

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({ id, label: id.toUpperCase(), kind: 'component', ...extra });
const edge = (source: string, target: string, label?: string): DiagramEdge => ({ id: `${source}->${target}`, source, target, ...(label ? { label } : {}) });

const chain = (direction: 'LR' | 'TB' = 'LR'): Pick<Diagram, 'nodes' | 'edges' | 'direction'> => ({
  direction,
  nodes: [node('a'), node('b'), node('c')],
  edges: [edge('a', 'b'), edge('b', 'c')],
});

/** Something shaped like a real architecture: fan-out, fan-in, a cycle, a
 *  note and a box nobody has wired up yet. */
const system = (direction: 'LR' | 'TB' = 'LR'): Pick<Diagram, 'nodes' | 'edges' | 'direction'> => ({
  direction,
  nodes: [
    node('user', { kind: 'actor', label: 'Customer' }),
    node('web', { label: 'Web app', detail: 'Next.js storefront' }),
    node('gw', { kind: 'service', label: 'API gateway', detail: 'Auth, rate limits' }),
    node('orders', { kind: 'service', label: 'Orders API', taskIds: ['t1'] }),
    node('cache', { kind: 'datastore', label: 'Redis', detail: 'Read-through, 5 min TTL' }),
    node('db', { kind: 'datastore', label: 'Postgres' }),
    node('outbox', { kind: 'queue', label: 'Outbox' }),
    node('inv', { kind: 'service', label: 'Cache invalidator with a long name that wraps' }),
    node('note', { kind: 'note', label: 'Stale reads are fine for 5 minutes' }),
    node('later', { label: 'Search (later)' }),
  ],
  edges: [
    edge('user', 'web'),
    edge('web', 'gw', 'HTTPS'),
    edge('gw', 'orders', 'REST'),
    edge('orders', 'cache', 'GET order:{id}'),
    edge('orders', 'db', 'SQL'),
    edge('db', 'outbox', 'CDC'),
    edge('outbox', 'inv'),
    edge('inv', 'cache', 'DEL'),
    edge('cache', 'orders', 'hit'),
  ],
});

function overlaps(nodes: DiagramNode[], at: Positions): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const pa = at.get(a.id)!;
      const pb = at.get(b.id)!;
      const sa = nodeSize(a);
      const sb = nodeSize(b);
      const apart = pa.x + sa.width <= pb.x || pb.x + sb.width <= pa.x || pa.y + sa.height <= pb.y || pb.y + sb.height <= pa.y;
      if (!apart) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}

test('a left-to-right chain is laid out left to right', () => {
  const at = autoLayout(chain(), 'LR').positions;
  assert.ok(at.get('a')!.x < at.get('b')!.x && at.get('b')!.x < at.get('c')!.x);
});

test('a top-to-bottom chain is laid out top to bottom', () => {
  const at = autoLayout(chain('TB'), 'TB').positions;
  assert.ok(at.get('a')!.y < at.get('b')!.y && at.get('b')!.y < at.get('c')!.y);
});

test('a real-sized system opens with nothing on top of anything, either way round', () => {
  for (const direction of ['LR', 'TB'] as const) {
    const d = system(direction);
    const { positions } = autoLayout(d, direction);
    assert.equal(positions.size, d.nodes.length);
    assert.deepEqual(overlaps(d.nodes, positions), [], direction);
  }
});

test('the layout starts at the origin', () => {
  const { positions } = autoLayout(system(), 'LR');
  assert.equal(Math.min(...[...positions.values()].map((p) => p.x)), 0);
  assert.equal(Math.min(...[...positions.values()].map((p) => p.y)), 0);
});

test('unconnected boxes go on a shelf under the flow, not beside where it starts', () => {
  const d = system('LR');
  const { positions } = autoLayout(d, 'LR');
  const connected = d.nodes.filter((n) => !['note', 'later'].includes(n.id));
  const bottom = Math.max(...connected.map((n) => positions.get(n.id)!.y + nodeSize(n).height));
  for (const id of ['note', 'later']) assert.ok(positions.get(id)!.y > bottom, `${id} sits below the graph`);
  assert.equal(positions.get('note')!.y, positions.get('later')!.y, 'side by side on one shelf');
});

test('when the flow runs top to bottom, the shelf is beside it', () => {
  const d = system('TB');
  const { positions } = autoLayout(d, 'TB');
  const connected = d.nodes.filter((n) => !['note', 'later'].includes(n.id));
  const right = Math.max(...connected.map((n) => positions.get(n.id)!.x + nodeSize(n).width));
  for (const id of ['note', 'later']) assert.ok(positions.get(id)!.x > right, `${id} sits to the right`);
});

test('a diagram of loose boxes is a grid, not a line', () => {
  const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
  const { positions } = autoLayout({ nodes, edges: [] }, 'LR');
  const rows = new Set([...positions.values()].map((p) => p.y));
  assert.ok(rows.size >= 2, 'more than one row');
  assert.deepEqual(overlaps(nodes, positions), []);
});

test('ranks leave room for the labels on the arrows between them', () => {
  const plain = autoLayout({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }, 'LR').positions;
  const long = 'publishes order events to subscribers';
  const labelled = autoLayout({ nodes: [node('a'), node('b')], edges: [edge('a', 'b', long)] }, 'LR').positions;
  const gap = (at: Positions) => at.get('b')!.x - (at.get('a')!.x + nodeSize(node('a')).width);
  assert.ok(gap(labelled) >= gap(plain) + labelSize(long).width - 20, 'the gap grows by about the label');
});

test('every arrow gets a route from its source to its target, with a place for its label', () => {
  const d = system();
  const { routes, positions } = autoLayout(d, 'LR');
  for (const e of d.edges) {
    const r = routes.get(e.id);
    assert.ok(r && r.points.length >= 2, e.id);
    assert.deepEqual(r.from, positions.get(e.source));
    assert.deepEqual(r.to, positions.get(e.target));
    if (e.label) assert.ok(r.label, `${e.id} has a label spot`);
  }
});

test('two arrows between the same boxes are laid out as two', () => {
  const d = { nodes: [node('a'), node('b')], edges: [edge('a', 'b', 'reads'), { ...edge('a', 'b', 'writes'), id: 'a->b#2' }] };
  const { routes } = autoLayout(d, 'LR');
  assert.equal(routes.size, 2);
});

test('saved positions are used as they are', () => {
  const d = chain();
  d.nodes = d.nodes.map((n, i) => ({ ...n, x: i * 10, y: 5 }));
  const { positions, routes } = resolveLayout(d);
  assert.deepEqual(positions.get('c'), { x: 20, y: 5 });
  assert.equal(routes.size, 0, 'hand-placed boxes are joined directly, not along a stale route');
});

test('a tidied diagram, saved and reloaded, keeps its routes', () => {
  const d = system();
  const { positions } = autoLayout(d, 'LR');
  const saved = { ...d, nodes: d.nodes.map((n) => ({ ...n, ...positions.get(n.id)! })) };
  const { routes } = resolveLayout(saved);
  assert.equal(routes.size, d.edges.length);
});

test('a box added to an arranged diagram lands beside what it connects to', () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0]!, x: 0, y: 0 }, { ...d.nodes[1]!, x: 300, y: 0 }, { ...d.nodes[2]!, x: 600, y: 0 }, node('d')];
  d.edges = [...d.edges, edge('b', 'd')];
  const { positions } = resolveLayout(d);
  const at = positions.get('d')!;
  assert.ok(at.x > 300 + nodeSize(d.nodes[1]!).width, 'after its source along the flow');
  assert.ok(at.x < 600 + nodeSize(d.nodes[2]!).width, 'not off past the far edge');
  assert.deepEqual(overlaps(d.nodes, positions), [], 'and on top of nothing');
  assert.deepEqual(positions.get('a'), { x: 0, y: 0 }, 'the arranged ones do not move');
});

test('a box with only a target lands before it', () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0]!, x: 400, y: 0 }, { ...d.nodes[1]!, x: 700, y: 0 }, { ...d.nodes[2]!, x: 1000, y: 0 }, node('z')];
  d.edges = [...d.edges, edge('z', 'a')];
  const at = resolveLayout(d).positions.get('z')!;
  assert.ok(at.x + nodeSize(node('z')).width < 400);
});

test('a new box with no placed neighbours goes past the arranged ones', () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0]!, x: 0, y: 0 }, { ...d.nodes[1]!, x: 300, y: 0 }, d.nodes[2]!, node('lone')];
  d.edges = [edge('a', 'b')];
  const { positions } = resolveLayout(d);
  const farEdge = 300 + nodeSize(d.nodes[1]!).width;
  assert.ok(positions.get('lone')!.x > farEdge);
  assert.deepEqual(overlaps(d.nodes, positions), []);
});

test('boxes with a subtitle or linked tasks are taller; long labels wrap rather than run on', () => {
  assert.ok(nodeSize(node('a', { detail: 'does things' })).height > nodeSize(node('a')).height);
  assert.ok(nodeSize(node('a', { taskIds: ['t1'] })).height > nodeSize(node('a')).height);
  const long = nodeSize(node('a', { label: 'A component with a really very long name indeed' }));
  assert.ok(long.width <= 250 && long.height > nodeSize(node('a')).height);
});

test('the same graph is laid out once, however often it is asked for', () => {
  const d = system();
  const first = autoLayout(d, 'LR');
  const route = (l: ReturnType<typeof autoLayout>) => l.routes.get('web->gw');
  const dragged = autoLayout({ ...d, nodes: d.nodes.map((n) => ({ ...n, x: 99, y: 99 })) }, 'LR');
  assert.equal(route(dragged), route(first), 'where boxes sit is not part of it: the same work, reused');
  assert.deepEqual([...dragged.positions], [...first.positions]);
  const renamed = autoLayout({ ...d, nodes: d.nodes.map((n) => (n.id === 'web' ? { ...n, label: 'Web storefront' } : n)) }, 'LR');
  assert.notEqual(route(renamed), route(first), 'what changes a box\'s size is');
  assert.notEqual(route(autoLayout(d, 'TB')), route(first));
});

test('a cached layout cannot be changed through what it hands out', () => {
  const d = system();
  const first = autoLayout(d, 'LR');
  first.positions.get('web')!.x += 500;
  assert.notEqual(autoLayout(d, 'LR').positions.get('web')!.x, first.positions.get('web')!.x, 'positions are copies');
  assert.throws(() => {
    'use strict';
    (first.routes.get('web->gw')!.points[0] as { x: number }).x = 1;
  }, TypeError, 'routes are frozen');
});
