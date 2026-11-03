import type { DiagramDirection } from '../../shared/types.ts';
import type { Point } from './layout.ts';

/**
 * Where an arrow runs between two boxes.
 *
 * Arrows on this canvas are not tied to fixed handles: a box has no "input
 * side". While a diagram is as the automatic layout left it, an arrow follows
 * the route dagre gave it, which keeps it clear of the boxes it passes. Once
 * either end is moved, it runs between the two sides that face each other —
 * so dragging a box anywhere never leaves its arrows looping round behind it.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function centre(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * The sides two boxes should be joined on. Clear space between them decides
 * it; when there is some both ways, the diagram's direction breaks the tie,
 * so a left-to-right diagram keeps joining boxes side to side.
 */
export function facingSides(a: Rect, b: Rect, direction: DiagramDirection = 'LR'): [Side, Side] {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const gapX = Math.abs(dx) - (a.width + b.width) / 2;
  const gapY = Math.abs(dy) - (a.height + b.height) / 2;
  const horizontal: [Side, Side] = dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  const vertical: [Side, Side] = dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  if (gapX > 0 && gapY > 0) {
    // Diagonal: the flow's own axis wins unless the other gap is far larger.
    if (direction === 'LR') return gapY > gapX * 2.5 ? vertical : horizontal;
    return gapX > gapY * 2.5 ? horizontal : vertical;
  }
  if (gapX > 0) return horizontal;
  if (gapY > 0) return vertical;
  // Overlapping: whichever way they are further apart.
  return Math.abs(dx) / (a.width || 1) >= Math.abs(dy) / (a.height || 1) ? horizontal : vertical;
}

/** The middle of one side, nudged along it by `offset` for parallel arrows. */
export function sidePoint(r: Rect, side: Side, offset = 0): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.width / 2 + offset, y: r.y };
    case 'bottom':
      return { x: r.x + r.width / 2 + offset, y: r.y + r.height };
    case 'left':
      return { x: r.x, y: r.y + r.height / 2 + offset };
    case 'right':
      return { x: r.x + r.width, y: r.y + r.height / 2 + offset };
  }
}

/** Where the line from a box's centre towards `toward` leaves the box. */
export function clipToRect(r: Rect, toward: Point): Point {
  const c = centre(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? r.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/**
 * A smooth path through route points: a uniform B-spline, the same curve
 * d3's `curveBasis` draws, so dagre's waypoints read as one sweep rather
 * than a polyline. It starts and ends exactly on the first and last point.
 */
export function splinePath(points: Point[]): string {
  if (points.length === 0) return '';
  const f = (n: number) => Math.round(n * 10) / 10;
  if (points.length === 1) return `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  if (points.length === 2) return `M${f(points[0]!.x)},${f(points[0]!.y)}L${f(points[1]!.x)},${f(points[1]!.y)}`;
  let d = `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  let x0 = points[0]!.x;
  let y0 = points[0]!.y;
  let x1 = points[1]!.x;
  let y1 = points[1]!.y;
  d += `L${f((5 * x0 + x1) / 6)},${f((5 * y0 + y1) / 6)}`;
  for (let i = 2; i < points.length; i++) {
    const { x, y } = points[i]!;
    d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 4 * x1 + x) / 6)},${f((y0 + 4 * y1 + y) / 6)}`;
    x0 = x1;
    y0 = y1;
    x1 = x;
    y1 = y;
  }
  // Close out on the last point, as curveBasis does.
  d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 5 * x1) / 6)},${f((y0 + 5 * y1) / 6)}`;
  d += `L${f(x1)},${f(y1)}`;
  return d;
}

/** The point halfway along a polyline, for a label with no spot of its own. */
export function midpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    lengths.push(l);
    total += l;
  }
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const l = lengths[i - 1]!;
    if (left <= l && l > 0) {
      const t = left / l;
      return { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t };
    }
    left -= l;
  }
  return points[points.length - 1]!;
}

/** An arrow from a box back to itself: a loop off its top-right corner. */
export function loopPath(r: Rect): { path: string; label: Point } {
  const sx = r.x + r.width;
  const sy = r.y + r.height * 0.35;
  const ex = r.x + r.width * 0.75;
  const ey = r.y;
  return {
    path: `M${sx},${sy} C${sx + 46},${sy} ${ex},${ey - 46} ${ex},${ey}`,
    label: { x: sx + 22, y: ey - 22 },
  };
}

/**
 * Offsets that keep arrows between the same two boxes apart — two calls
 * each way, a read and a write — rather than drawn on top of each other.
 */
export function lanes(edges: { id: string; source: string; target: string }[]): Map<string, number> {
  const groups = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = [e.source, e.target].sort().join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  const out = new Map<string, number>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, i) => out.set(id, (i - (ids.length - 1) / 2) * 14));
  }
  return out;
}
