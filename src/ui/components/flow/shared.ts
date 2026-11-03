import { createContext, useContext } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { DiagramDirection, EdgeArrows, NodeKind, TaskCounts } from '../../../shared/types.ts';
import type { Route } from '../../lib/layout.ts';

/** What the canvas keeps on each box. Width and height come from the layout's
 *  size estimate, so the drawing and the layout agree on how big a box is. */
export type FlowData = {
  label: string;
  kind: NodeKind;
  detail?: string;
  description?: string;
  notes?: string;
  taskIds?: string[];
  width: number;
  height: number;
  /** Progress of the linked tasks; absent when the box has none. */
  progress?: TaskCounts;
};
export type FlowNode = Node<FlowData, 'plan'>;

export type EdgeData = {
  label?: string;
  dashed?: boolean;
  arrows?: Exclude<EdgeArrows, 'end'>;
  /** Where the automatic layout drew it, while both ends stay put. */
  route?: Route;
  /** Offset from its neighbours when several arrows join the same boxes. */
  lane?: number;
};
export type FlowEdge = Edge<EdgeData, 'plan'>;

export type NodePatch = Partial<Pick<FlowData, 'label' | 'kind' | 'detail' | 'description' | 'notes' | 'taskIds'>>;
export type EdgePatch = Partial<Pick<EdgeData, 'label' | 'dashed' | 'arrows'>> & { source?: string; target?: string };

/**
 * What a box or an arrow can ask of the editor around it. Boxes and arrows
 * are rendered by React Flow, far from the editor's state; this is how an
 * inline rename on the canvas reaches the same save path as the panel.
 */
export interface CanvasApi {
  direction: DiagramDirection;
  /** `node:<id>` or `edge:<id>` while that item's text is edited in place. */
  editing: string | null;
  startEditing(key: string): void;
  /** Null cancels. */
  finishNodeLabel(id: string, label: string | null): void;
  finishEdgeLabel(id: string, label: string | null): void;
  selectEdge(id: string): void;
}

export const CanvasContext = createContext<CanvasApi | null>(null);

export function useCanvas(): CanvasApi {
  const api = useContext(CanvasContext);
  if (!api) throw new Error('useCanvas outside the diagram editor');
  return api;
}

export const KIND_LABEL: Record<NodeKind, string> = {
  component: 'Component',
  service: 'Service',
  datastore: 'Datastore',
  queue: 'Queue',
  external: 'External',
  actor: 'Actor',
  note: 'Note',
};

export const KIND_GLYPH: Record<NodeKind, string> = {
  component: '▢',
  service: '⚙',
  datastore: '⛁',
  queue: '☰',
  external: '☁',
  actor: '☺',
  note: '✎',
};

/** What each kind is for, said where the kind is chosen. */
export const KIND_HINT: Record<NodeKind, string> = {
  component: 'A part of the codebase: a module, a UI, a library',
  service: 'Something that runs: an API, a worker, a job',
  datastore: 'Where state lives: a database, a cache, a bucket',
  queue: 'A queue, topic or stream between parts',
  external: 'A system you depend on but do not own',
  actor: 'A person or client that uses the system',
  note: 'An annotation on the diagram, not a part of the system',
};
