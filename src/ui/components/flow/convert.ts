import { MarkerType } from '@xyflow/react';
import { nodeSize, resolveLayout, samePoint, type Layout, type Point } from '../../lib/layout.ts';
import { classNames } from '../../lib/format.ts';
import { countTasks, descendants } from '../../../shared/plan.ts';
import type { Diagram, Plan, TaskCounts } from '../../../shared/types.ts';
import type { EdgeData, FlowData, FlowEdge, FlowNode } from './shared.ts';

/**
 * Between a diagram as the plan holds it and the boxes and arrows React Flow
 * draws: building one from the other, and the small helpers the editor uses
 * to keep them in step.
 */

export function toFlow(diagram: Diagram, plan: Plan): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const layout = resolveLayout(diagram);
  const nodes: FlowNode[] = diagram.nodes.map((n) => ({
    id: n.id,
    type: 'plan' as const,
    position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      ...sized({
        label: n.label,
        kind: n.kind,
        ...(n.detail ? { detail: n.detail } : {}),
        ...(n.description ? { description: n.description } : {}),
        ...(n.notes ? { notes: n.notes } : {}),
        ...(n.taskIds?.length ? { taskIds: n.taskIds } : {}),
        width: 0,
        height: 0,
      }),
      ...progressOf(plan, n.taskIds),
    },
  }));
  const edges = diagram.edges.map((e) => withRoute(makeEdge(e), layout));
  return { nodes, edges };
}

/** What the canvas draws from: the graph without its revision or authorship. */
export function signatureOf(d: Diagram): string {
  return JSON.stringify([d.nodes, d.edges, d.direction]);
}

export function makeEdge(
  e: { id: string; source: string; target: string; label?: string; dashed?: boolean; arrows?: string; route?: EdgeData['route'] },
  selected?: boolean,
): FlowEdge {
  const arrows = e.arrows === 'both' || e.arrows === 'none' ? e.arrows : undefined;
  const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'plan',
    data: {
      ...(e.label ? { label: e.label } : {}),
      ...(e.dashed ? { dashed: true } : {}),
      ...(arrows ? { arrows } : {}),
      ...(e.route ? { route: e.route } : {}),
    },
    ...(arrows !== 'none' ? { markerEnd: marker } : {}),
    ...(arrows === 'both' ? { markerStart: marker } : {}),
    className: classNames(e.dashed && 'is-dashed'),
    ...(e.dashed ? { style: { strokeDasharray: '6 4' } } : {}),
    ...(selected ? { selected } : {}),
  };
}

export function withRoute(edge: FlowEdge, layout: Layout): FlowEdge {
  const route = layout.routes.get(edge.id);
  const data = { ...edge.data };
  if (route) data.route = route;
  else delete data.route;
  return { ...edge, data };
}

/**
 * A route survives a reload from the server while both of its boxes are
 * still where it was drawn for — even if a rename since means a fresh
 * layout would now put them elsewhere.
 */
export function keepRoutes(prev: FlowEdge[], next: FlowEdge[], nodes: FlowNode[]): FlowEdge[] {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return next.map((e) => {
    if (e.data?.route) return e;
    const old = prev.find((p) => p.id === e.id && p.source === e.source && p.target === e.target)?.data?.route;
    if (old && samePoint(at.get(e.source), old.from) && samePoint(at.get(e.target), old.to)) return { ...e, data: { ...e.data, route: old } };
    return e;
  });
}

export function keepSelection<T extends { id: string; selected?: boolean }>(prev: T[], next: T[]): T[] {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => (selected.has(x.id) ? { ...x, selected: true } : x));
}

export function sized(data: FlowData): FlowData {
  const { width, height } = nodeSize(data);
  return { ...data, width, height };
}

export function contentOf(d: FlowData) {
  return {
    label: d.label,
    kind: d.kind,
    ...(d.detail ? { detail: d.detail } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.notes ? { notes: d.notes } : {}),
    ...(d.taskIds?.length ? { taskIds: d.taskIds } : {}),
  };
}

export function edgeContent(d: EdgeData | undefined) {
  return { ...(d?.label ? { label: d.label } : {}), ...(d?.dashed ? { dashed: true } : {}), ...(d?.arrows ? { arrows: d.arrows } : {}) };
}

export function graphOf(ns: FlowNode[], es: FlowEdge[]) {
  return {
    nodes: ns.map((n) => ({ id: n.id, ...contentOf(n.data) })),
    edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.data?.label ? { label: e.data.label } : {}) })),
  };
}

export function positionsOf(ns: FlowNode[]) {
  return new Map(ns.map((n) => [n.id, n.position]));
}

export function sizesOf(ns: FlowNode[]) {
  return new Map(ns.map((n) => [n.id, { width: n.data.width, height: n.data.height }]));
}

export function freeEdgeId(edges: { id: string }[], source: string, target: string): string {
  let id = `${source}->${target}`;
  for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
  return id;
}

export function round(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function progressOf(plan: Plan, taskIds: string[] | undefined): { progress?: TaskCounts } {
  if (!taskIds?.length) return { progress: undefined };
  const seen = new Map<string, Plan['tasks'][number]>();
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    if (!task) continue;
    seen.set(task.id, task);
    for (const d of descendants(plan, task.id)) seen.set(d.id, d);
  }
  if (seen.size === 0) return { progress: undefined };
  return { progress: countTasks({ tasks: [...seen.values()] }) };
}
