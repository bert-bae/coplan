import dagre from '@dagrejs/dagre';
import type { Diagram, DiagramDirection, DiagramEdge, DiagramNode } from '../../shared/types.ts';

/**
 * Automatic layout for diagrams.
 *
 * Claude writes diagrams as nodes and edges with no coordinates; the user
 * arranges them by hand. Layout bridges the two:
 *
 * - A diagram nobody has arranged is laid out whole by dagre, in ranks along
 *   its flow, with room left between ranks for the arrows' labels and a route
 *   for every arrow that keeps it off the boxes it passes.
 * - Boxes with no connections are not ranked — dagre would put them all in
 *   the first rank, beside wherever the flow starts. They go on a shelf of
 *   their own beside the graph.
 * - Boxes the user placed stay exactly where they are. A box Claude adds to
 *   an arranged diagram is put next to what it connects to, in the first
 *   free spot, rather than off past the far edge.
 * - "Tidy" throws the hand layout away and lays out everything again.
 */

export interface Box {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where dagre drew an arrow. Only valid while both of its boxes stand where
 * dagre put them (`from` and `to`, their top-left corners) — once either is
 * dragged, the canvas draws the arrow straight between them instead.
 */
export interface Route {
  points: Point[];
  /** The centre of the space dagre left for the arrow's label. */
  label?: Point;
  from: Point;
  to: Point;
}

export type Positions = Map<string, Point>;

export interface Layout {
  positions: Positions;
  /** By edge id. */
  routes: Map<string, Route>;
}

type SizedNode = Pick<DiagramNode, 'label' | 'detail' | 'kind' | 'taskIds'>;
type Graph = { nodes: (SizedNode & { id: string })[]; edges: Pick<DiagramEdge, 'id' | 'source' | 'target' | 'label'>[] };

/* ------------------------------------------------------------------ *
 * Sizes
 * ------------------------------------------------------------------ */

// Kept in step with `.flow-node` in style.css: the canvas sets each box to
// exactly this width and at least this height, so the layout leaves the gaps
// it means to.
const LABEL_CHAR = 7.4; // 13px semibold
const DETAIL_CHAR = 6.1; // 11px
const LABEL_CHROME = 70; // glyph, info button, padding and borders around the label
const DETAIL_CHROME = 25;
const MIN_WIDTH = 170;
const MAX_WIDTH = 250;

/** A box's size from its text: a width band that fits the label on one or
 *  two lines, taller for a subtitle and for a progress strip. */
export function nodeSize(node: SizedNode): Box {
  const label = node.label.length * LABEL_CHAR;
  const detail = node.detail ? Math.min(node.detail.length, 46) * DETAIL_CHAR : 0;
  const raw = Math.max(label + LABEL_CHROME, detail ? detail / (node.detail!.length > 34 ? 2 : 1) + DETAIL_CHROME : 0);
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)) / 10) * 10;
  const labelLines = Math.min(2, Math.max(1, Math.ceil(label / (width - LABEL_CHROME))));
  const detailLines = node.detail ? Math.min(2, Math.max(1, Math.ceil((node.detail.length * DETAIL_CHAR) / (width - DETAIL_CHROME)))) : 0;
  let height = 18 + labelLines * 17 + (detailLines ? 2 + detailLines * 14 : 0) + (node.taskIds?.length ? 16 : 0);
  if (node.kind === 'datastore') height += 6;
  return { width, height: Math.max(44, height) };
}

/** An arrow label's footprint, matching `.flow-edge-label`. */
export function labelSize(label: string): Box {
  const text = label.length * 6.2;
  const lines = Math.min(2, Math.ceil(text / 160));
  return { width: Math.round(Math.min(172, text + 14)), height: 8 + lines * 14 };
}

/* ------------------------------------------------------------------ *
 * Whole-diagram layout
 * ------------------------------------------------------------------ */

const SPACING: Record<DiagramDirection, { nodesep: number; ranksep: number; edgesep: number }> = {
  // In LR, nodesep is the vertical gap between boxes in one rank.
  LR: { nodesep: 30, ranksep: 72, edgesep: 14 },
  TB: { nodesep: 44, ranksep: 58, edgesep: 14 },
};
const SHELF_GAP = 72;

/** Top-left positions for every node, and a route for every arrow, ignoring
 *  any saved positions. */
export function autoLayout(diagram: Graph, direction: DiagramDirection): Layout {
  const degree = new Map<string, number>();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const connected = diagram.nodes.filter((n) => degree.has(n.id));
  const loose = diagram.nodes.filter((n) => !degree.has(n.id));
  const positions: Positions = new Map();
  const routes = new Map<string, Route>();

  if (connected.length) {
    const ids = new Set(connected.map((n) => n.id));
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direction, ...SPACING[direction], marginx: 0, marginy: 0, acyclicer: 'greedy', ranker: 'network-simplex' });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of connected) g.setNode(n.id, { ...nodeSize(n) });
    for (const e of diagram.edges) {
      if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
      g.setEdge(e.source, e.target, e.label ? { ...labelSize(e.label), labelpos: 'c' } : { width: 0, height: 0 }, e.id);
    }
    dagre.layout(g);
    for (const n of connected) {
      const laid = g.node(n.id) as { x: number; y: number; width: number; height: number };
      // dagre gives centres; the canvas wants top-left corners.
      positions.set(n.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
    }
    for (const e of diagram.edges) {
      const laid = g.edge({ v: e.source, w: e.target, name: e.id }) as { points?: Point[]; x?: number; y?: number } | undefined;
      if (!laid?.points?.length) continue;
      routes.set(e.id, {
        points: laid.points.map((p) => ({ x: p.x, y: p.y })),
        ...(e.label && laid.x !== undefined && laid.y !== undefined ? { label: { x: laid.x, y: laid.y } } : {}),
        from: positions.get(e.source)!,
        to: positions.get(e.target)!,
      });
    }
  }

  shelve(loose, positions, new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)])), direction);
  return normalize({ positions, routes });
}

/**
 * Boxes with no arrows, on a shelf beside the graph: a row under it when the
 * flow runs left to right, a column beside it when it runs top to bottom.
 * With no graph at all they make a grid.
 */
function shelve(loose: Graph['nodes'], positions: Positions, size: Map<string, Box>, direction: DiagramDirection): void {
  if (!loose.length) return;
  const sizes = loose.map((n) => size.get(n.id)!);
  const bounds = boundsOf(positions, size);
  const gapX = 40;
  const gapY = 32;
  if (!bounds) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(loose.length * 1.6)));
    let y = 0;
    for (let row = 0; row * cols < loose.length; row++) {
      let x = 0;
      const items = loose.slice(row * cols, row * cols + cols);
      let tallest = 0;
      items.forEach((n, i) => {
        const s = sizes[row * cols + i]!;
        positions.set(n.id, { x, y });
        x += s.width + gapX;
        tallest = Math.max(tallest, s.height);
      });
      y += tallest + gapY;
    }
    return;
  }
  if (direction === 'LR') {
    const limit = Math.max(bounds.maxX, bounds.minX + 3 * (MAX_WIDTH + gapX));
    let x = bounds.minX;
    let y = bounds.maxY + SHELF_GAP;
    let tallest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i]!;
      if (x > bounds.minX && x + s.width > limit) {
        x = bounds.minX;
        y += tallest + gapY;
        tallest = 0;
      }
      positions.set(n.id, { x, y });
      x += s.width + gapX;
      tallest = Math.max(tallest, s.height);
    });
  } else {
    const limit = Math.max(bounds.maxY, bounds.minY + 4 * (60 + gapY));
    let x = bounds.maxX + SHELF_GAP;
    let y = bounds.minY;
    let widest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i]!;
      if (y > bounds.minY && y + s.height > limit) {
        y = bounds.minY;
        x += widest + gapX;
        widest = 0;
      }
      positions.set(n.id, { x, y });
      y += s.height + gapY;
      widest = Math.max(widest, s.width);
    });
  }
}

/** Shift everything so the layout starts at the origin. */
function normalize(layout: Layout): Layout {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of layout.positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX) || (minX === 0 && minY === 0)) return layout;
  const at = (p: Point) => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) });
  const positions: Positions = new Map([...layout.positions].map(([id, p]) => [id, at(p)]));
  const routes = new Map(
    [...layout.routes].map(([id, r]) => [
      id,
      {
        points: r.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        ...(r.label ? { label: { x: r.label.x - minX, y: r.label.y - minY } } : {}),
        from: at(r.from),
        to: at(r.to),
      },
    ]),
  );
  return { positions, routes };
}

/* ------------------------------------------------------------------ *
 * Saved positions, and newcomers among them
 * ------------------------------------------------------------------ */

/**
 * Positions to draw with: saved ones where they exist, and a place for the
 * rest. Routes are kept only for arrows whose boxes both stand where the
 * automatic layout would put them.
 */
export function resolveLayout(diagram: Pick<Diagram, 'nodes' | 'edges' | 'direction'>): Layout {
  const auto = autoLayout(diagram, diagram.direction);
  const placed = diagram.nodes.filter((n) => n.x !== undefined && n.y !== undefined);
  if (placed.length === 0) return auto;

  const positions: Positions = new Map(placed.map((n) => [n.id, { x: n.x!, y: n.y! }]));
  if (placed.length < diagram.nodes.length) placeNewcomers(diagram, positions, auto.positions);

  const routes = new Map<string, Route>();
  for (const e of diagram.edges) {
    const r = auto.routes.get(e.id);
    if (r && samePoint(positions.get(e.source), r.from) && samePoint(positions.get(e.target), r.to)) routes.set(e.id, r);
  }
  return { positions, routes };
}

/** Kept for callers that only want positions. */
export function resolvePositions(diagram: Pick<Diagram, 'nodes' | 'edges' | 'direction'>): Positions {
  return resolveLayout(diagram).positions;
}

const RANK_GAP = 90;
const CLEARANCE = 22;

/**
 * Put each unplaced box beside the placed boxes it connects to: after its
 * sources along the flow (or before its targets, if it only has those),
 * centred on them, and moved along the rank to the nearest spot where it
 * overlaps nothing. Boxes connected to nothing placed are laid out together
 * and set past the far edge of the arranged ones.
 */
export function placeNewcomers(diagram: Pick<Diagram, 'nodes' | 'edges' | 'direction'>, positions: Positions, auto: Positions): void {
  const lr = diagram.direction === 'LR';
  const size = new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)]));
  // Along the flow, so a chain of newcomers is placed link by link.
  const fresh = diagram.nodes
    .filter((n) => !positions.has(n.id))
    .sort((a, b) => {
      const pa = auto.get(a.id) ?? { x: 0, y: 0 };
      const pb = auto.get(b.id) ?? { x: 0, y: 0 };
      return lr ? pa.x - pb.x || pa.y - pb.y : pa.y - pb.y || pa.x - pb.x;
    });

  const strays: typeof fresh = [];
  for (const n of fresh) {
    const s = size.get(n.id)!;
    const sources = diagram.edges.filter((e) => e.target === n.id && e.source !== n.id && positions.has(e.source)).map((e) => e.source);
    const targets = diagram.edges.filter((e) => e.source === n.id && e.target !== n.id && positions.has(e.target)).map((e) => e.target);
    const anchors = sources.length ? sources : targets;
    if (!anchors.length) {
      strays.push(n);
      continue;
    }
    const boxes = anchors.map((id) => ({ ...positions.get(id)!, ...size.get(id)! }));
    const centre = {
      x: boxes.reduce((t, b) => t + b.x + b.width / 2, 0) / boxes.length,
      y: boxes.reduce((t, b) => t + b.y + b.height / 2, 0) / boxes.length,
    };
    const after = sources.length > 0;
    const want = lr
      ? {
          x: after ? Math.max(...boxes.map((b) => b.x + b.width)) + RANK_GAP : Math.min(...boxes.map((b) => b.x)) - RANK_GAP - s.width,
          y: centre.y - s.height / 2,
        }
      : {
          x: centre.x - s.width / 2,
          y: after ? Math.max(...boxes.map((b) => b.y + b.height)) + RANK_GAP : Math.min(...boxes.map((b) => b.y)) - RANK_GAP - s.height,
        };
    positions.set(n.id, freeSpot(want, s, positions, size, lr));
  }

  if (!strays.length) return;
  const sub = autoLayout(
    { nodes: strays.map((n) => ({ ...n, id: n.id })), edges: diagram.edges.filter((e) => strays.some((n) => n.id === e.source) && strays.some((n) => n.id === e.target)) },
    diagram.direction,
  );
  const bounds = boundsOf(positions, size)!;
  for (const n of strays) {
    const p = sub.positions.get(n.id) ?? { x: 0, y: 0 };
    positions.set(n.id, lr ? { x: p.x + bounds.maxX + RANK_GAP, y: p.y + bounds.minY } : { x: p.x + bounds.minX, y: p.y + bounds.maxY + RANK_GAP });
  }
}

/** The nearest spot to `want` where a new box overlaps nothing on the
 *  canvas — for a box added from the toolbar or beside another. */
export function findFreeSpot(want: Point, s: Box, positions: Positions, size: Map<string, Box>, lr: boolean): Point {
  return freeSpot(want, s, positions, size, lr);
}

/** The nearest spot to `want`, moving across the flow, where a box of size
 *  `s` overlaps nothing already placed. */
function freeSpot(want: Point, s: Box, positions: Positions, size: Map<string, Box>, lr: boolean): Point {
  const clear = (p: Point) =>
    [...positions].every(([id, q]) => {
      const b = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
      return (
        p.x + s.width + CLEARANCE <= q.x || q.x + b.width + CLEARANCE <= p.x || p.y + s.height + CLEARANCE <= q.y || q.y + b.height + CLEARANCE <= p.y
      );
    });
  const step = lr ? 26 : 40;
  for (let k = 0; k < 60; k++) {
    const offset = Math.ceil(k / 2) * step * (k % 2 ? 1 : -1);
    const p = lr ? { x: want.x, y: want.y + offset } : { x: want.x + offset, y: want.y };
    if (clear(p)) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  // Nothing near is free: one more rank along the flow.
  return freeSpot(lr ? { x: want.x + s.width + RANK_GAP, y: want.y } : { x: want.x, y: want.y + s.height + RANK_GAP }, s, positions, size, lr);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The extent of everything placed. Boxes without a known size count as
 *  the smallest box. */
export function boundsOf(positions: Positions, size: Map<string, Box>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (positions.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, p] of positions) {
    const s = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return { minX, minY, maxX, maxY };
}

export function samePoint(a: Point | undefined, b: Point | undefined): boolean {
  return Boolean(a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5);
}
