import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { store, useStore } from '../store.ts';
import { MarkdownField } from './Editable.tsx';
import { ProgressBar, STATUS_GLYPH, STATUS_LABEL } from './Progress.tsx';
import { autoLayout, nodeSize, resolvePositions } from '../lib/layout.ts';
import { useResolvedTheme } from '../lib/theme.ts';
import { classNames } from '../lib/format.ts';
import { countTasks, descendants, outline } from '../../shared/plan.ts';
import {
  NODE_KINDS,
  type Diagram,
  type DiagramDirection,
  type DiagramEdgeInput,
  type DiagramNode,
  type DiagramNodeInput,
  type NodeKind,
  type Plan,
  type TaskCounts,
} from '../../shared/types.ts';

/**
 * The architecture workspace: a React Flow canvas with a details panel beside
 * it.
 *
 * The canvas is where the shape of the system is decided — drag boxes, draw
 * arrows between handles, Backspace to delete. The panel is where each part is
 * decided: select a box and edit what it is, the reasoning behind it, and the
 * tasks that build it; select an arrow and say what flows along it. Every
 * change saves the whole graph back, and the plan's change log records it in
 * words ("connected API → Cache") so Claude can read what moved.
 *
 * Boxes linked to tasks show those tasks' progress, so the same picture tells
 * you how far Claude has got.
 */

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

type FlowData = {
  label: string;
  kind: NodeKind;
  detail?: string;
  notes?: string;
  taskIds?: string[];
  direction: DiagramDirection;
  width: number;
  /** Progress of the linked tasks; absent when the box has none. */
  progress?: TaskCounts;
};
type FlowNode = Node<FlowData, 'plan'>;
type FlowEdge = Edge<{ label?: string; dashed?: boolean }>;

export interface GraphPatch {
  nodes: DiagramNodeInput[];
  edges: DiagramEdgeInput[];
  direction?: DiagramDirection;
  /** The diagram revision this graph was edited from. */
  expect?: number;
}

type NodePatch = Partial<Pick<FlowData, 'label' | 'kind' | 'detail' | 'notes' | 'taskIds'>>;

export function DiagramEditor(props: {
  diagram: Diagram;
  plan: Plan;
  /** Resolves with the diagram's revision after the save, or null if refused. */
  onSave: (patch: GraphPatch) => Promise<number | null>;
  /** The panel's content when nothing is selected: the diagram itself. */
  aside: ReactNode;
}) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

const nodeTypes = { plan: memo(PlanNode) };

function Editor({
  diagram,
  plan,
  onSave,
  aside,
}: {
  diagram: Diagram;
  plan: Plan;
  onSave: (patch: GraphPatch) => Promise<number | null>;
  aside: ReactNode;
}) {
  const theme = useResolvedTheme();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<FlowNode[]>(() => toFlowNodes(diagram, plan));
  const [edges, setEdges] = useState<FlowEdge[]>(() => toFlowEdges(diagram));
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const dragging = useRef(false);
  const queue = useRef<{ pending: GraphPatch | null; busy: boolean }>({ pending: null, busy: false });

  // The plan object is replaced on every broadcast, so follow the graph's
  // content rather than its identity — otherwise a comment elsewhere in the
  // plan would reset the canvas mid-gesture.
  const signature = useMemo(() => JSON.stringify([diagram.nodes, diagram.edges, diagram.direction]), [diagram]);
  /** The revision the canvas's own state was loaded from. Saves are made
   *  against it, so a change that landed elsewhere since is never overwritten
   *  — not even one that arrived mid-drag, while the canvas was not listening. */
  const baseRev = useRef(diagram.rev);
  useEffect(() => {
    // Mid-gesture or mid-save the canvas is ahead of the server; the save
    // queue reconciles once it drains.
    if (dragging.current || queue.current.busy || queue.current.pending) return;
    setNodes((prev) => keepSelection(prev, toFlowNodes(diagram, plan)));
    setEdges((prev) => keepSelection(prev, toFlowEdges(diagram)));
    baseRev.current = diagram.rev;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content
  }, [signature]);

  // Task progress changes far more often than the graph does, and must not
  // move anything: patch it into the boxes in place.
  const progressKey = useMemo(() => JSON.stringify(plan.tasks.map((t) => [t.id, t.status, t.parentId])), [plan.tasks]);
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, ...progressOf(plan, n.data.taskIds) } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content
  }, [progressKey]);

  // Another part of the page asked to show a box: select it and bring it in.
  const focusTarget = useStore((s) => s.focusTarget);
  useEffect(() => {
    const prefix = `node:${diagram.id}:`;
    if (!focusTarget?.startsWith(prefix)) return;
    const id = focusTarget.slice(prefix.length);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    window.requestAnimationFrame(() => void flow.fitView({ nodes: [{ id }], padding: 1.2, duration: 250, maxZoom: 1.2 }));
    store.set({ focusTarget: null });
  }, [focusTarget, diagram.id, flow]);

  /**
   * Saving, one at a time and latest-wins.
   *
   * A drag, a rename and a connect can land within one round trip. Sending
   * them concurrently would race, and each would carry the revision the
   * canvas had before the others landed — so all but the first would be
   * refused as stale. Instead there is at most one save in flight; anything
   * newer replaces whatever is waiting behind it, and each save carries the
   * revision the daemon handed back for the one before.
   */
  const latestRev = () => store.getState().session?.plan?.diagrams.find((d) => d.id === diagram.id)?.rev;

  const resyncFromServer = useCallback(() => {
    const plan = store.getState().session?.plan;
    const current = plan?.diagrams.find((d) => d.id === diagram.id);
    if (!plan || !current) return;
    setNodes((prev) => keepSelection(prev, toFlowNodes(current, plan)));
    setEdges((prev) => keepSelection(prev, toFlowEdges(current)));
    baseRev.current = current.rev;
  }, [diagram.id]);

  const flush = useCallback(async () => {
    const q = queue.current;
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.pending) {
        const patch = q.pending;
        q.pending = null;
        const savedRev = await onSave({ ...patch, expect: baseRev.current });
        if (savedRev !== null) {
          // Build on the revision this save produced — not on whatever the
          // store holds now, which may include a change the canvas never loaded.
          baseRev.current = savedRev;
        } else {
          // Refused — changed elsewhere, or invalid. Show what is really saved.
          q.pending = null;
          resyncFromServer();
        }
      }
    } finally {
      q.busy = false;
    }
    // Something newer than our last save may have arrived while we were busy
    // and been held back; take it now.
    if (latestRev() !== undefined && latestRev() !== baseRev.current) resyncFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state through refs
  }, [onSave, resyncFromServer]);

  const persist = useCallback(
    (ns: FlowNode[], es: FlowEdge[], direction?: DiagramDirection) => {
      const superseded = queue.current.pending;
      queue.current.pending = {
        nodes: ns.map((n) => ({
          id: n.id,
          label: n.data.label,
          kind: n.data.kind,
          ...(n.data.detail ? { detail: n.data.detail } : {}),
          notes: n.data.notes ?? '',
          taskIds: n.data.taskIds ?? [],
          x: Math.round(n.position.x),
          y: Math.round(n.position.y),
        })),
        edges: es.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...(e.data?.label ? { label: e.data.label } : {}),
          ...(e.data?.dashed ? { dashed: true } : {}),
        })),
        // A patch waiting behind the one in flight is replaced, not merged —
        // except for the direction, which only the relayout ever sets.
        ...(direction ?? superseded?.direction ? { direction: direction ?? superseded?.direction } : {}),
      };
      void flush();
    },
    [flush],
  );

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (edgesRef.current.some((e) => e.source === conn.source && e.target === conn.target)) return;
      const next = [...edgesRef.current, makeEdge({ id: `${conn.source}->${conn.target}`, source: conn.source, target: conn.target })];
      setEdges(next);
      persist(nodesRef.current, next);
    },
    [persist],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      const goneIds = new Set(gone.map((n) => n.id));
      const cutIds = new Set(cut.map((e) => e.id));
      const ns = nodesRef.current.filter((n) => !goneIds.has(n.id));
      const es = edgesRef.current.filter((e) => !cutIds.has(e.id) && !goneIds.has(e.source) && !goneIds.has(e.target));
      setNodes(ns);
      setEdges(es);
      persist(ns, es);
    },
    [persist],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, moved: FlowNode[]) => {
      dragging.current = false;
      const at = new Map(moved.map((n) => [n.id, n.position]));
      const ns = nodesRef.current.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n));
      persist(ns, edgesRef.current);
    },
    [persist],
  );

  const updateNode = (id: string, patch: NodePatch) => {
    const ns = nodesRef.current.map((n) => {
      if (n.id !== id) return n;
      const data: FlowData = { ...n.data, ...patch };
      if (!data.detail) delete data.detail;
      return { ...n, data: { ...data, width: nodeSize(data).width, ...progressOf(plan, data.taskIds) } };
    });
    setNodes(ns);
    persist(ns, edgesRef.current);
  };

  const updateEdge = (id: string, patch: { label?: string; dashed?: boolean }) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const data = { ...e.data, ...patch };
      if (!data.label) delete data.label;
      return makeEdge({ id: e.id, source: e.source, target: e.target, ...data }, e.selected);
    });
    setEdges(es);
    persist(nodesRef.current, es);
  };

  const select = (kind: 'node' | 'edge', id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })));
  };

  const clearSelection = () => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
  };

  const removeSelected = () => {
    void flow.deleteElements({ nodes: nodesRef.current.filter((n) => n.selected), edges: edgesRef.current.filter((e) => e.selected) });
  };

  const addNode = (kind: NodeKind) => {
    const rect = wrapper.current?.getBoundingClientRect();
    const centre = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    let n = nodesRef.current.length + 1;
    while (nodesRef.current.some((x) => x.id === `n${n}`)) n++;
    const data: FlowData = { label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, direction: diagram.direction, width: 0 };
    data.width = nodeSize(data).width;
    const node: FlowNode = {
      id: `n${n}`,
      type: 'plan',
      position: { x: Math.round(centre.x - data.width / 2), y: Math.round(centre.y - 22) },
      data,
      selected: true,
    };
    const ns = [...nodesRef.current.map((x) => ({ ...x, selected: false })), node];
    setNodes(ns);
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    persist(ns, edgesRef.current);
  };

  const relayout = (direction: DiagramDirection) => {
    const graph = {
      nodes: nodesRef.current.map((n) => ({ id: n.id, label: n.data.label, kind: n.data.kind, ...(n.data.detail ? { detail: n.data.detail } : {}) })),
      edges: edgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    const at = autoLayout(graph, direction);
    const ns = nodesRef.current.map((n) => ({ ...n, position: at.get(n.id) ?? n.position, data: { ...n.data, direction } }));
    setNodes(ns);
    persist(ns, edgesRef.current, direction);
    window.requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 250 }));
  };

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);

  let panel: ReactNode;
  if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0]!;
    panel = (
      <NodePanel
        key={node.id}
        node={node}
        nodes={nodes}
        edges={edges}
        plan={plan}
        onChange={(patch) => updateNode(node.id, patch)}
        onSelect={select}
        onRemove={removeSelected}
        onClose={clearSelection}
      />
    );
  } else if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    const edge = selectedEdges[0]!;
    panel = (
      <EdgePanel
        key={edge.id}
        edge={edge}
        nodes={nodes}
        onChange={(patch) => updateEdge(edge.id, patch)}
        onSelect={select}
        onRemove={removeSelected}
        onClose={clearSelection}
      />
    );
  } else if (selectedNodes.length + selectedEdges.length > 1) {
    panel = (
      <div className="arch-panel-body">
        <p className="panel-kicker">Selection</p>
        <p>
          {selectedNodes.length} box(es) and {selectedEdges.length} arrow(s) selected.
        </p>
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-danger" onClick={removeSelected}>
            Delete selection
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clearSelection}>
            Clear selection
          </button>
        </div>
      </div>
    );
  } else {
    panel = aside;
  }

  return (
    <div className="arch-body">
      <div ref={wrapper} className="flow">
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDelete={onDelete}
          onNodeDragStart={() => {
            dragging.current = true;
          }}
          onNodeDragStop={onNodeDragStop}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={['Backspace', 'Delete']}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          maxZoom={2}
          defaultEdgeOptions={{ type: 'smoothstep' }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" style={{ width: 150, height: 96 }} nodeBorderRadius={4} />
          <Panel position="top-left" className="flow-toolbar">
            <AddMenu onAdd={addNode} />
            <button type="button" className="btn btn-sm" title="Lay the whole diagram out again" onClick={() => relayout(diagram.direction)}>
              Tidy layout
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title={diagram.direction === 'LR' ? 'Flow top to bottom' : 'Flow left to right'}
              onClick={() => relayout(diagram.direction === 'LR' ? 'TB' : 'LR')}
            >
              {diagram.direction === 'LR' ? '→ Left to right' : '↓ Top to bottom'}
            </button>
          </Panel>
        </ReactFlow>
      </div>
      <aside className="arch-panel" aria-label="Details">
        {panel}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Nodes and edges
 * ------------------------------------------------------------------ */

function PlanNode({ data, selected }: NodeProps<FlowNode>) {
  const horizontal = data.direction === 'LR';
  const p = data.progress;
  const state = !p ? null : p.blocked ? 'blocked' : p.inProgress ? 'in_progress' : p.done === p.total ? 'done' : 'todo';
  return (
    <div
      className={classNames('flow-node', `kind-${data.kind}`, selected && 'is-selected', state && `progress-${state}`)}
      style={{ width: data.width }}
    >
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} />
      <div className="flow-node-head">
        <span className="flow-node-glyph" aria-hidden="true">
          {KIND_GLYPH[data.kind]}
        </span>
        <span className="flow-node-label">{data.label}</span>
        {data.notes && (
          <span className="flow-node-flag" title="Has notes" aria-label="has notes">
            ¶
          </span>
        )}
      </div>
      {data.detail && <div className="flow-node-detail">{data.detail}</div>}
      {p && (
        <div className="flow-node-progress" title={`${p.done} of ${p.total} tasks done${p.inProgress ? `, ${p.inProgress} in progress` : ''}${p.blocked ? `, ${p.blocked} blocked` : ''}`}>
          <ProgressBar counts={p} compact />
          <span>
            {p.done}/{p.total}
          </span>
        </div>
      )}
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} />
    </div>
  );
}

function progressOf(plan: Plan, taskIds: string[] | undefined): { progress?: TaskCounts } {
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

function toFlowNodes(diagram: Diagram, plan: Plan): FlowNode[] {
  const at = resolvePositions(diagram);
  return diagram.nodes.map((n) => ({
    id: n.id,
    type: 'plan' as const,
    position: at.get(n.id) ?? { x: 0, y: 0 },
    data: {
      label: n.label,
      kind: n.kind,
      ...(n.detail ? { detail: n.detail } : {}),
      ...(n.notes ? { notes: n.notes } : {}),
      ...(n.taskIds?.length ? { taskIds: n.taskIds } : {}),
      direction: diagram.direction,
      width: nodeSize(n).width,
      ...progressOf(plan, n.taskIds),
    },
  }));
}

function toFlowEdges(diagram: Diagram): FlowEdge[] {
  return diagram.edges.map((e) => makeEdge(e));
}

function makeEdge(e: { id: string; source: string; target: string; label?: string; dashed?: boolean }, selected?: boolean): FlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    ...(e.label ? { label: e.label } : {}),
    data: { ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}) },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    className: e.dashed ? 'is-dashed' : undefined,
    ...(e.dashed ? { style: { strokeDasharray: '6 4' } } : {}),
    ...(selected ? { selected } : {}),
  };
}

function keepSelection<T extends { id: string; selected?: boolean }>(prev: T[], next: T[]): T[] {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => (selected.has(x.id) ? { ...x, selected: true } : x));
}

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

function AddMenu({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-menu">
      <button type="button" className="btn btn-sm btn-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        + Box
      </button>
      {open && (
        <div className="add-menu-list" role="menu">
          {NODE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              className="add-menu-item"
              onClick={() => {
                setOpen(false);
                onAdd(k);
              }}
            >
              <span className={classNames('kind-swatch', `kind-${k}`)} aria-hidden="true">
                {KIND_GLYPH[k]}
              </span>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The details panel
 * ------------------------------------------------------------------ */

/** A text input that commits on Enter or blur, not on every keystroke. */
function CommitInput({
  value,
  label,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  label: string;
  placeholder?: string;
  className?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      className={classNames('input', className)}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function NodePanel({
  node,
  nodes,
  edges,
  plan,
  onChange,
  onSelect,
  onRemove,
  onClose,
}: {
  node: FlowNode;
  nodes: FlowNode[];
  edges: FlowEdge[];
  plan: Plan;
  onChange: (patch: NodePatch) => void;
  onSelect: (kind: 'node' | 'edge', id: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const outgoing = edges.filter((e) => e.source === node.id);
  const incoming = edges.filter((e) => e.target === node.id);
  const linked = node.data.taskIds ?? [];
  const rows = outline(plan);
  const linkable = rows.filter((r) => !linked.includes(r.task.id));

  return (
    <div className="arch-panel-body" aria-label={`Details of ${node.data.label}`}>
      <header className="panel-top">
        <span className={classNames('kind-swatch', `kind-${node.data.kind}`)} aria-hidden="true">
          {KIND_GLYPH[node.data.kind]}
        </span>
        <span className="panel-kicker">{KIND_LABEL[node.data.kind]}</span>
        <span className="item-id">{node.id}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn is-tiny" aria-label="Close details" title="Back to the diagram" onClick={onClose}>
          ×
        </button>
      </header>

      <CommitInput className="panel-title-input" value={node.data.label} label="Box label" onCommit={(label) => label && onChange({ label })} />

      <label className="field">
        <span className="field-label">Kind</span>
        <select className="input" value={node.data.kind} onChange={(e) => onChange({ kind: e.target.value as NodeKind })}>
          {NODE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">On the box</span>
        <CommitInput value={node.data.detail ?? ''} label="Box detail" placeholder="One line: responsibility or technology" onCommit={(detail) => onChange({ detail })} />
      </label>

      <div className="field">
        <span className="field-label">Notes and decisions</span>
        <MarkdownField
          value={node.data.notes ?? ''}
          label={`notes on ${node.data.label}`}
          placeholder="Nothing decided here yet."
          emptyAction="Add notes"
          rows={6}
          onSave={(notes) => onChange({ notes })}
        />
      </div>

      <div className="field">
        <span className="field-label">Built by</span>
        {linked.length > 0 ? (
          <ul className="panel-tasks">
            {linked.map((id) => {
              const task = plan.tasks.find((t) => t.id === id);
              if (!task) return null;
              return (
                <li key={id}>
                  <span className={classNames('status-dot is-static', `is-${task.status}`)} title={STATUS_LABEL[task.status]} aria-label={STATUS_LABEL[task.status]}>
                    {STATUS_GLYPH[task.status]}
                  </span>
                  <button type="button" className="link panel-task" onClick={() => store.focus('task', id)}>
                    {task.title}
                  </button>
                  <button
                    type="button"
                    className="icon-btn is-tiny"
                    aria-label={`Unlink ${task.title}`}
                    title="Unlink"
                    onClick={() => onChange({ taskIds: linked.filter((t) => t !== id) })}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted panel-empty">No tasks linked. Link the tasks that build this part to see its progress on the box.</p>
        )}
        {linkable.length > 0 && (
          <select
            className="input"
            aria-label={`Link a task to ${node.data.label}`}
            value=""
            onChange={(e) => e.target.value && onChange({ taskIds: [...linked, e.target.value] })}
          >
            <option value="">Link a task…</option>
            {linkable.map(({ task, number, depth }) => (
              <option key={task.id} value={task.id}>
                {' '.repeat(depth * 3)}
                {number} {task.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {(outgoing.length > 0 || incoming.length > 0) && (
        <div className="field">
          <span className="field-label">Connections</span>
          <ul className="panel-links">
            {outgoing.map((e) => (
              <li key={e.id}>
                <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                  → {name(e.target)}
                </button>
                {e.data?.label && <span className="muted"> {e.data.label}</span>}
              </li>
            ))}
            {incoming.map((e) => (
              <li key={e.id}>
                <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                  ← {name(e.source)}
                </button>
                {e.data?.label && <span className="muted"> {e.data.label}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="panel-foot">
        {confirming ? (
          <span className="item-confirm">
            Delete this box and its arrows?
            <button type="button" className="link is-danger" onClick={onRemove}>
              Delete
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="link is-danger" onClick={() => setConfirming(true)}>
            Delete box
          </button>
        )}
      </footer>
    </div>
  );
}

function EdgePanel({
  edge,
  nodes,
  onChange,
  onSelect,
  onRemove,
  onClose,
}: {
  edge: FlowEdge;
  nodes: FlowNode[];
  onChange: (patch: { label?: string; dashed?: boolean }) => void;
  onSelect: (kind: 'node' | 'edge', id: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  return (
    <div className="arch-panel-body" aria-label="Details of the selected arrow">
      <header className="panel-top">
        <span className="panel-kicker">Arrow</span>
        <span className="spacer" />
        <button type="button" className="icon-btn is-tiny" aria-label="Close details" title="Back to the diagram" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="panel-edge">
        <button type="button" className="link" onClick={() => onSelect('node', edge.source)}>
          {name(edge.source)}
        </button>
        <span aria-hidden="true"> → </span>
        <button type="button" className="link" onClick={() => onSelect('node', edge.target)}>
          {name(edge.target)}
        </button>
      </p>
      <label className="field">
        <span className="field-label">What flows along it</span>
        <CommitInput value={edge.data?.label ?? ''} label="Arrow label" placeholder="e.g. REST, publishes events" onCommit={(label) => onChange({ label })} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={Boolean(edge.data?.dashed)} onChange={(e) => onChange({ dashed: e.target.checked })} />
        Dashed — optional, async or future
      </label>
      <footer className="panel-foot">
        <button type="button" className="link is-danger" onClick={onRemove}>
          Delete arrow
        </button>
      </footer>
    </div>
  );
}

export type { DiagramNode };
