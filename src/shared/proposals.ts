/**
 * What a proposal would do, for the page that shows it: the plan as it
 * would be, the changes in words, and per diagram which boxes and arrows it
 * adds, changes or takes away. Pure, and shared, so the preview is the
 * accept — the same edits through the same code — not an imitation of it.
 */
import { applyOps, proposalStaleness } from './plan.ts';
import type { Diagram, DiagramEdge, DiagramNode, Plan, Proposal } from './types.ts';

export type DiffMark = 'added' | 'changed' | 'removed';

export interface ProposalPreview {
  /** The plan with the proposal accepted; null when it cannot be. */
  after: Plan | null;
  /** What accepting it would change, in words. */
  changes: string[];
  /** Why it cannot be accepted as it is. */
  error: string | null;
  /** What moved since it was made (then it cannot be accepted). */
  stale: string[];
  /** The diagrams it changes, in the plan's order. */
  diagrams: string[];
}

export function previewProposal(plan: Plan, p: Proposal): ProposalPreview {
  const stale = proposalStaleness(plan, p);
  const diagrams = plan.diagrams.map((d) => d.id).filter((id) => p.ops.some((op) => touchesDiagram(op, id)));
  try {
    // Shown even where the design is signed off: accepting it then needs the
    // design reopened, which the page says, but what it proposes is the same.
    const trial = structuredClone(plan);
    delete trial.design;
    delete trial.submission;
    const { plan: after, changes } = applyOps(trial, [{ op: 'accept_proposal', id: p.id }], 'user');
    const added = after.diagrams.map((d) => d.id).filter((id) => !plan.diagrams.some((d) => d.id === id));
    return {
      after,
      changes: changes.filter((c) => !c.summary.startsWith('accepted proposal')).map((c) => c.summary),
      error: null,
      stale,
      diagrams: [...diagrams, ...added],
    };
  } catch (err) {
    return { after: null, changes: [], error: err instanceof Error ? err.message : String(err), stale, diagrams };
  }
}

function touchesDiagram(op: Proposal['ops'][number], id: string): boolean {
  switch (op.op) {
    case 'upsert_diagram':
    case 'move_diagram':
      return op.id === id;
    case 'upsert_node':
    case 'remove_node':
    case 'upsert_edge':
    case 'remove_edge':
      return op.diagramId === id;
    case 'remove':
      return op.kind === 'diagram' && op.id === id;
    default:
      return false;
  }
}

export interface DiagramDiff {
  nodes: Record<string, DiffMark>;
  edges: Record<string, DiffMark>;
  /** What it takes away, so the preview can still draw it, struck out. */
  removedNodes: DiagramNode[];
  removedEdges: DiagramEdge[];
}

/** Which boxes and arrows a change adds, changes or takes away. Layout and
 *  task links are not part of it. */
export function diagramDiff(before: Diagram | undefined, after: Diagram | undefined): DiagramDiff {
  const out: DiagramDiff = { nodes: {}, edges: {}, removedNodes: [], removedEdges: [] };
  const was = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const is = new Map((after?.nodes ?? []).map((n) => [n.id, n]));
  const content = (n: DiagramNode) => JSON.stringify([n.label, n.kind, n.detail ?? '', n.description ?? '', n.notes ?? '']);
  for (const [id, n] of is) {
    const old = was.get(id);
    if (!old) out.nodes[id] = 'added';
    else if (content(old) !== content(n)) out.nodes[id] = 'changed';
  }
  for (const [id, n] of was) {
    if (is.has(id)) continue;
    out.nodes[id] = 'removed';
    out.removedNodes.push(n);
  }
  const wasE = new Map((before?.edges ?? []).map((e) => [e.id, e]));
  const isE = new Map((after?.edges ?? []).map((e) => [e.id, e]));
  const edge = (e: DiagramEdge) => JSON.stringify([e.source, e.target, e.label ?? '', Boolean(e.dashed), e.arrows ?? 'end']);
  for (const [id, e] of isE) {
    const old = wasE.get(id);
    if (!old) out.edges[id] = 'added';
    else if (edge(old) !== edge(e)) out.edges[id] = 'changed';
  }
  for (const [id, e] of wasE) {
    if (isE.has(id)) continue;
    out.edges[id] = 'removed';
    out.removedEdges.push(e);
  }
  return out;
}

/** The diagram as the preview draws it: as it would be, with what it takes
 *  away still in place, to be drawn struck out. */
export function previewDiagram(before: Diagram | undefined, after: Diagram, diff: DiagramDiff): Diagram {
  const keptIds = new Set(after.nodes.map((n) => n.id));
  return {
    ...after,
    nodes: [...after.nodes, ...diff.removedNodes.filter((n) => !keptIds.has(n.id))],
    // An arrow to a box that is gone is drawn while the box still is.
    edges: [...after.edges, ...diff.removedEdges.filter((e) => before?.edges.some((b) => b.id === e.id))],
  };
}
