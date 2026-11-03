import dagre from '@dagrejs/dagre';
import type { Diagram, DiagramDirection, DiagramNode } from '../../shared/types.ts';

/**
 * Automatic layout for diagrams.
 *
 * Claude writes diagrams as nodes and edges with no coordinates; the user
 * arranges them by hand. Layout bridges the two: unplaced nodes are put where
 * dagre would put them, placed nodes stay exactly where the user left them,
 * and "Tidy" throws the hand layout away and lays out everything.
 */

export interface Box {
  width: number;
  height: number;
}

/** A box's size from its text, so dagre leaves the right gaps. Kept in step
 *  with the node styles: a fixed width band, taller when there is detail. */
export function nodeSize(node: Pick<DiagramNode, 'label' | 'detail' | 'kind'>): Box {
  const longest = Math.max(node.label.length, Math.min(node.detail?.length ?? 0, 40) * 0.8);
  const width = Math.round(Math.min(240, Math.max(140, longest * 7.5 + 40)));
  const height = node.detail ? 64 : 44;
  return node.kind === 'datastore' ? { width, height: height + 12 } : { width, height };
}

export type Positions = Map<string, { x: number; y: number }>;

/** Top-left positions for every node, by dagre, ignoring any saved ones. */
export function autoLayout(diagram: Pick<Diagram, 'nodes' | 'edges'>, direction: DiagramDirection): Positions {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 70, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of diagram.nodes) g.setNode(node.id, { ...nodeSize(node) });
  for (const edge of diagram.edges) {
    if (edge.source !== edge.target) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  const out: Positions = new Map();
  for (const node of diagram.nodes) {
    const laid = g.node(node.id) as { x: number; y: number; width: number; height: number } | undefined;
    if (!laid) continue;
    // dagre gives centres; the canvas wants top-left corners.
    out.set(node.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
  }
  return out;
}

/**
 * Positions to draw with: saved ones where they exist, dagre's for the rest.
 *
 * When only some nodes are placed — Claude added a box to a diagram the user
 * had arranged — the newcomers are laid out with the whole graph and then
 * shifted clear of the arranged part, so nothing lands on top of anything.
 */
export function resolvePositions(diagram: Pick<Diagram, 'nodes' | 'edges' | 'direction'>): Positions {
  const placed = diagram.nodes.filter((n) => n.x !== undefined && n.y !== undefined);
  const out: Positions = new Map(placed.map((n) => [n.id, { x: n.x!, y: n.y! }]));
  if (placed.length === diagram.nodes.length) return out;

  const auto = autoLayout(diagram, diagram.direction);
  if (placed.length === 0) return auto;

  // Push the unplaced nodes past the far edge of the arranged ones.
  let farX = -Infinity;
  let farY = -Infinity;
  for (const n of placed) {
    const size = nodeSize(n);
    farX = Math.max(farX, n.x! + size.width);
    farY = Math.max(farY, n.y! + size.height);
  }
  const fresh = diagram.nodes.filter((n) => !out.has(n.id));
  const minX = Math.min(...fresh.map((n) => auto.get(n.id)?.x ?? 0));
  const minY = Math.min(...fresh.map((n) => auto.get(n.id)?.y ?? 0));
  for (const n of fresh) {
    const p = auto.get(n.id) ?? { x: 0, y: 0 };
    out.set(
      n.id,
      diagram.direction === 'LR' ? { x: p.x - minX + farX + 80, y: p.y } : { x: p.x, y: p.y - minY + farY + 80 },
    );
  }
  return out;
}
