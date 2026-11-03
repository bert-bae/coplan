import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipToRect, facingSides, lanes, splinePath } from '../ui/lib/geometry.ts';
import { CLIP_KIND, freeId, parseClip, pasteClip, serializeClip, toClip } from '../ui/lib/clipboard.ts';

/** The canvas's pure parts: where arrows run, and what a copy carries. */

const box = (x: number, y: number, width = 200, height = 50) => ({ x, y, width, height });

/* ------------------------------------------------------------ geometry */

test('boxes side by side are joined side to side; stacked ones top to bottom', () => {
  assert.deepEqual(facingSides(box(0, 0), box(400, 0)), ['right', 'left']);
  assert.deepEqual(facingSides(box(400, 0), box(0, 0)), ['left', 'right']);
  assert.deepEqual(facingSides(box(0, 0), box(0, 200)), ['bottom', 'top']);
  assert.deepEqual(facingSides(box(0, 200), box(0, 0)), ['top', 'bottom']);
});

test('a diagonal follows the flow: sideways left to right, downwards top to bottom', () => {
  assert.deepEqual(facingSides(box(0, 0), box(300, 150), 'LR'), ['right', 'left']);
  assert.deepEqual(facingSides(box(0, 0), box(300, 150), 'TB'), ['bottom', 'top']);
});

test('a route is clipped to where it leaves the real box', () => {
  assert.deepEqual(clipToRect(box(0, 0, 100, 40), { x: 300, y: 20 }), { x: 100, y: 20 });
  assert.deepEqual(clipToRect(box(0, 0, 100, 40), { x: 50, y: -200 }), { x: 50, y: 0 });
});

test('a spline starts on the first point and ends on the last', () => {
  const d = splinePath([
    { x: 0, y: 0 },
    { x: 50, y: 80 },
    { x: 100, y: 0 },
  ]);
  assert.match(d, /^M0,0/);
  assert.match(d, /L100,0$/);
  assert.equal(splinePath([{ x: 0, y: 0 }, { x: 10, y: 10 }]), 'M0,0L10,10');
});

test('arrows between the same two boxes are drawn apart, either way round', () => {
  const offsets = lanes([
    { id: 'a', source: 'x', target: 'y' },
    { id: 'b', source: 'y', target: 'x' },
    { id: 'c', source: 'x', target: 'z' },
  ]);
  assert.equal(offsets.get('a'), -offsets.get('b')!);
  assert.notEqual(offsets.get('a'), 0);
  assert.equal(offsets.has('c'), false, 'a lone arrow keeps the middle');
});

/* ----------------------------------------------------------- clipboard */

const nodes = [
  { id: 'api', label: 'API', kind: 'service' as const, description: 'Takes requests.', x: 100, y: 100 },
  { id: 'db', label: 'Postgres', kind: 'datastore' as const, taskIds: ['t1', 'gone'], x: 400, y: 100 },
];
const edges = [
  { source: 'api', target: 'db', label: 'SQL' },
  { source: 'api', target: 'elsewhere' },
];

test('a copy carries the boxes and only the arrows between them', () => {
  const clip = toClip(nodes, edges)!;
  assert.equal(clip.kind, CLIP_KIND);
  assert.deepEqual(clip.edges, [{ source: 'api', target: 'db', label: 'SQL' }]);
  assert.deepEqual(parseClip(serializeClip(clip)), clip, 'and survives the clipboard');
});

test('anything else on the clipboard is not a copy', () => {
  assert.equal(parseClip('hello'), null);
  assert.equal(parseClip(`{"kind":"${CLIP_KIND}","nodes":"nope","edges":[]}`), null);
  assert.equal(parseClip(`{"kind":"${CLIP_KIND}"`), null, 'truncated');
  const odd = parseClip(JSON.stringify({ kind: CLIP_KIND, version: 1, nodes: [{ id: 'a', kind: 'spaceship', x: 'far' }], edges: [{ source: 'a', target: 'b' }] }))!;
  assert.deepEqual(odd.nodes, [{ id: 'a', label: 'a', kind: 'component', x: 0, y: 0 }], 'odd fields are made safe');
  assert.deepEqual(odd.edges, [], 'an arrow to a box not in the copy is dropped');
});

test('pasting renames what collides, drops links to tasks this plan lacks, and keeps the shape', () => {
  const clip = toClip(nodes, edges)!;
  const pasted = pasteClip(clip, ['api', 'cache'], new Set(['t1']), { x: 32, y: 32 });
  assert.deepEqual(
    pasted.nodes.map((n) => [n.id, n.x, n.y]),
    [
      ['api-2', 132, 132],
      ['db', 432, 132],
    ],
  );
  assert.deepEqual(pasted.nodes[1]!.taskIds, ['t1']);
  assert.equal(pasted.nodes[0]!.description, 'Takes requests.');
  assert.deepEqual(pasted.edges, [{ source: 'api-2', target: 'db', label: 'SQL' }]);
});

test('a copy of a copy counts on rather than stacking suffixes', () => {
  assert.equal(freeId('cache', new Set(['cache'])), 'cache-2');
  assert.equal(freeId('cache-2', new Set(['cache', 'cache-2'])), 'cache-3');
  assert.equal(freeId('x'.repeat(60), new Set(['x'.repeat(60)])).length <= 60, true);
});
