/**
 * Graph questions and graph edits the canvas asks of a diagram, as pure
 * functions over its boxes and arrows: who a box is connected to and in
 * which direction, and the edits that rewire around a box — putting one into
 * an arrow, taking one out of a chain without breaking it.
 */

export interface EdgeLike {
  id: string;
  source: string;
  target: string;
  label?: string;
  dashed?: boolean;
  arrows?: 'both' | 'none';
}

/**
 * How a box relates to the one in focus:
 *
 * - `focus` — the box itself;
 * - `to` — the focus has an arrow to it (it is downstream);
 * - `from` — it has an arrow to the focus (it is upstream);
 * - `both` — arrows both ways, or an arrow drawn without a direction;
 * - `to2` / `from2` — one step further along either way.
 */
export type NodeRelation = 'focus' | 'to' | 'from' | 'both' | 'to2' | 'from2';

/** How an arrow relates to the focus: `out` leaves it, `in` arrives at it,
 *  `both` is two-way, `out2` / `in2` are one step further. */
export type EdgeRelation = 'out' | 'in' | 'both' | 'out2' | 'in2';

export interface Relations {
  nodes: Map<string, NodeRelation>;
  edges: Map<string, EdgeRelation>;
}

const twoWay = (e: EdgeLike) => e.arrows === 'both' || e.arrows === 'none';

/**
 * Everything connected to `focus`, one step out — or two, when `hops` is 2 —
 * with the direction of each connection.
 */
export function relationsOf(focus: string, edges: readonly EdgeLike[], hops: 1 | 2 = 1): Relations {
  const nodes = new Map<string, NodeRelation>([[focus, 'focus']]);
  const rels = new Map<string, EdgeRelation>();
  const mark = (id: string, rel: 'to' | 'from' | 'both') => {
    const was = nodes.get(id);
    if (was === 'focus') return;
    nodes.set(id, !was || was === rel ? rel : 'both');
  };
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (e.source !== focus && e.target !== focus) continue;
    const other = e.source === focus ? e.target : e.source;
    if (twoWay(e)) {
      rels.set(e.id, 'both');
      mark(other, 'both');
    } else if (e.source === focus) {
      rels.set(e.id, 'out');
      mark(other, 'to');
    } else {
      rels.set(e.id, 'in');
      mark(other, 'from');
    }
  }
  if (hops < 2) return { nodes, edges: rels };

  const first = new Map(nodes);
  const downstream = [...first].filter(([, r]) => r === 'to' || r === 'both').map(([id]) => id);
  const upstream = [...first].filter(([, r]) => r === 'from' || r === 'both').map(([id]) => id);
  for (const e of edges) {
    if (e.source === e.target || rels.has(e.id)) continue;
    // Further downstream: from a box the focus sends to, onwards.
    const onward = downstream.includes(e.source) ? e.target : twoWay(e) && downstream.includes(e.target) ? e.source : null;
    if (onward && !first.has(onward)) {
      rels.set(e.id, 'out2');
      if (!nodes.has(onward)) nodes.set(onward, 'to2');
      continue;
    }
    // Further upstream: into a box that sends to the focus.
    const back = upstream.includes(e.target) ? e.source : twoWay(e) && upstream.includes(e.source) ? e.target : null;
    if (back && !first.has(back)) {
      rels.set(e.id, 'in2');
      if (!nodes.has(back)) nodes.set(back, 'from2');
    }
  }
  return { nodes, edges: rels };
}

/**
 * Take boxes out of the diagram without breaking the flow through them:
 * every box that sent into the removed ones is connected to every box they
 * sent on to. A→B→C with B removed becomes A→C, keeping what A sent along
 * the way. Arrows that already exist are not doubled.
 */
export function bridgeOver<E extends EdgeLike>(removed: ReadonlySet<string>, edges: readonly E[]): { kept: E[]; bridges: Omit<EdgeLike, 'id'>[] } {
  const kept = edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
  const bridges: Omit<EdgeLike, 'id'>[] = [];
  const exists = (s: string, t: string) => kept.some((e) => e.source === s && e.target === t) || bridges.some((b) => b.source === s && b.target === t);
  for (const into of edges) {
    if (removed.has(into.source) || !removed.has(into.target)) continue;
    // Follow the flow through the removed boxes to where it comes out.
    const seen = new Set<string>([into.target]);
    const queue = [into.target];
    while (queue.length) {
      const at = queue.shift()!;
      for (const out of edges) {
        if (out.source !== at) continue;
        if (removed.has(out.target)) {
          if (!seen.has(out.target)) {
            seen.add(out.target);
            queue.push(out.target);
          }
          continue;
        }
        if (out.target === into.source || exists(into.source, out.target)) continue;
        bridges.push({
          source: into.source,
          target: out.target,
          ...(into.label ? { label: into.label } : {}),
          ...(into.dashed || out.dashed ? { dashed: true } : {}),
        });
      }
    }
  }
  return { kept, bridges };
}

/**
 * Put box `id` into arrow `edge`: A→C becomes A→id→C. The first half keeps
 * what flowed along the arrow and how it was drawn; the second is drawn the
 * same way.
 */
export function splitEdge<E extends EdgeLike>(edge: E, id: string): [Omit<EdgeLike, 'id'>, Omit<EdgeLike, 'id'>] {
  const style = { ...(edge.dashed ? { dashed: true } : {}), ...(edge.arrows ? { arrows: edge.arrows } : {}) };
  return [
    { source: edge.source, target: id, ...(edge.label ? { label: edge.label } : {}), ...style },
    { source: id, target: edge.target, ...style },
  ];
}
