import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeOver, relationsOf, splitEdge, type EdgeLike } from '../ui/lib/graph.ts';
import { History } from '../ui/lib/history.ts';

/** The graph questions behind highlighting, and the rewiring edits. */

const e = (source: string, target: string, extra: Partial<EdgeLike> = {}): EdgeLike => ({ id: `${source}->${target}`, source, target, ...extra });

// web → gw → api → db, api → cache ↔ (two-way) worker, user → web, api → api
const EDGES = [e('user', 'web'), e('web', 'gw'), e('gw', 'api', { label: 'REST' }), e('api', 'db'), e('api', 'cache'), e('cache', 'worker', { arrows: 'both' }), e('api', 'api')];

/* ------------------------------------------------------------ relations */

test('a box relates to its neighbours by direction', () => {
  const { nodes, edges } = relationsOf('api', EDGES);
  assert.deepEqual(Object.fromEntries(nodes), { api: 'focus', gw: 'from', db: 'to', cache: 'to' });
  assert.deepEqual(Object.fromEntries(edges), { 'gw->api': 'in', 'api->db': 'out', 'api->cache': 'out' });
});

test('arrows both ways, or without a direction, make a two-way neighbour', () => {
  assert.equal(relationsOf('cache', EDGES).nodes.get('worker'), 'both');
  const both = relationsOf('a', [e('a', 'b'), e('b', 'a')]);
  assert.equal(both.nodes.get('b'), 'both', 'an arrow each way is both ways');
});

test('two steps out follows the flow in each direction, never back through the focus', () => {
  const { nodes, edges } = relationsOf('api', EDGES, 2);
  assert.equal(nodes.get('web'), 'from2', 'upstream of upstream');
  assert.equal(nodes.get('worker'), 'to2', 'downstream of downstream, across a two-way arrow');
  assert.equal(nodes.has('user'), false, 'three steps is too far');
  assert.equal(edges.get('web->gw'), 'in2');
  assert.equal(edges.get('cache->worker'), 'out2');
  assert.equal(nodes.get('gw'), 'from', 'first-step relations are not overwritten');
});

test('a box with no connections relates only to itself', () => {
  const { nodes, edges } = relationsOf('lonely', EDGES);
  assert.deepEqual([...nodes], [['lonely', 'focus']]);
  assert.equal(edges.size, 0);
});

/* ------------------------------------------------------------- rewiring */

test('deleting the middle of a chain joins its ends, keeping what flowed in', () => {
  const { kept, bridges } = bridgeOver(new Set(['gw']), EDGES);
  assert.ok(!kept.some((x) => x.source === 'gw' || x.target === 'gw'));
  assert.deepEqual(bridges, [{ source: 'web', target: 'api' }]);
  const labelled = bridgeOver(new Set(['api']), [e('gw', 'api', { label: 'REST', dashed: true }), e('api', 'db')]);
  assert.deepEqual(labelled.bridges, [{ source: 'gw', target: 'db', label: 'REST', dashed: true }]);
});

test('deleting several boxes in a row bridges across all of them', () => {
  const { bridges } = bridgeOver(new Set(['web', 'gw']), EDGES);
  assert.deepEqual(bridges, [{ source: 'user', target: 'api' }]);
});

test('bridging never doubles an arrow or loops a box to itself', () => {
  const { bridges } = bridgeOver(new Set(['b']), [e('a', 'b'), e('b', 'c'), e('a', 'c'), e('c', 'b'), e('b', 'a')]);
  // a→b→c: a→c exists already. a→b→a and c→b→c would loop. c→b→a is a real
  // flow through b, so it is kept as c→a.
  assert.deepEqual(bridges, [{ source: 'c', target: 'a' }]);
  const fan = bridgeOver(new Set(['hub']), [e('x', 'hub'), e('y', 'hub'), e('hub', 'p'), e('hub', 'q')]);
  assert.equal(fan.bridges.length, 4, 'every way in to every way out');
});

test('a box put into an arrow takes its place on both halves', () => {
  const [first, second] = splitEdge(e('a', 'c', { label: 'events', dashed: true, arrows: 'both' }), 'b');
  assert.deepEqual(first, { source: 'a', target: 'b', label: 'events', dashed: true, arrows: 'both' });
  assert.deepEqual(second, { source: 'b', target: 'c', dashed: true, arrows: 'both' });
});

/* --------------------------------------------------------------- history */

test('undo steps back through recorded states, redo forward, and a new edit drops the redos', () => {
  const h = new History<number>();
  assert.equal(h.undo(0), null);
  h.record(0);
  h.record(1);
  assert.equal(h.undo(2), 1);
  assert.equal(h.undo(1), 0);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo(0), 1);
  h.record(1);
  assert.equal(h.canRedo, false, 'a new edit forgets what was undone');
});

test('a refused edit leaves no step behind to undo to', () => {
  const h = new History<number>();
  h.record(0);
  h.record(1); // the edit that took 1 → 2 was refused: the state is 1 again
  h.discardLast();
  assert.equal(h.undo(1), 0, 'one undo goes back past the refused edit, not to where it already is');
});

test('history keeps only so many steps', () => {
  const h = new History<number>(3);
  for (let i = 0; i < 10; i++) h.record(i);
  assert.equal(h.undo(10), 9);
  assert.equal(h.undo(9), 8);
  assert.equal(h.undo(8), 7);
  assert.equal(h.undo(7), null);
});
