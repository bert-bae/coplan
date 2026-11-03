import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, nodeSize, resolvePositions } from '../ui/lib/layout.ts';
import type { Diagram, DiagramNode } from '../shared/types.ts';

/** Automatic layout: Claude's diagrams arrive without coordinates. */

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({ id, label: id.toUpperCase(), kind: 'component', ...extra });

const chain = (direction: 'LR' | 'TB' = 'LR'): Pick<Diagram, 'nodes' | 'edges' | 'direction'> => ({
  direction,
  nodes: [node('a'), node('b'), node('c')],
  edges: [
    { id: 'a->b', source: 'a', target: 'b' },
    { id: 'b->c', source: 'b', target: 'c' },
  ],
});

test('a left-to-right chain is laid out left to right', () => {
  const at = autoLayout(chain(), 'LR');
  assert.ok(at.get('a')!.x < at.get('b')!.x && at.get('b')!.x < at.get('c')!.x);
});

test('a top-to-bottom chain is laid out top to bottom', () => {
  const at = autoLayout(chain('TB'), 'TB');
  assert.ok(at.get('a')!.y < at.get('b')!.y && at.get('b')!.y < at.get('c')!.y);
});

test('saved positions are used as they are', () => {
  const d = chain();
  d.nodes = d.nodes.map((n, i) => ({ ...n, x: i * 10, y: 5 }));
  const at = resolvePositions(d);
  assert.deepEqual(at.get('c'), { x: 20, y: 5 });
});

test('a new node lands clear of the ones the user arranged', () => {
  const d = chain();
  d.nodes = [{ ...d.nodes[0]!, x: 0, y: 0 }, { ...d.nodes[1]!, x: 300, y: 0 }, d.nodes[2]!];
  const at = resolvePositions(d);
  const farEdge = 300 + nodeSize(d.nodes[1]!).width;
  assert.ok(at.get('c')!.x > farEdge, 'past the right edge of the arranged nodes');
  assert.deepEqual(at.get('a'), { x: 0, y: 0 }, 'the arranged ones do not move');
});

test('boxes with detail are taller', () => {
  assert.ok(nodeSize(node('a', { detail: 'does things' })).height > nodeSize(node('a')).height);
});
