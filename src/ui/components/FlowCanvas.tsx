import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { autoLayout, nodeSize, resolvePositions } from '../lib/layout.ts';
import { useResolvedTheme } from '../lib/theme.ts';
import { classNames } from '../lib/format.ts';
import {
  NODE_KINDS,
  type Diagram,
  type DiagramDirection,
  type DiagramEdgeInput,
  type DiagramNodeInput,
  type NodeKind,
} from '../../shared/types.ts';

/**
 * A diagram on a React Flow canvas.
 *
 * Everything the reader does here is an edit to the plan: dragging boxes,
 * drawing an arrow from one handle to another, relabelling, deleting with
 * Backspace. Each one saves the whole graph back, and the change log records
 * it in words ("connected API → Cache") so Claude can read what moved.
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

const KIND_GLYPH: Record<NodeKind, string> = {
  component: '▢',
  service: '⚙',
  datastore: '⛁',
  queue: '☰',
  external: '☁',
  actor: '☺',
  note: '✎',
};

type FlowData = { label: string; kind: NodeKind; detail?: string; direction: DiagramDirection; width: number };
type FlowNode = Node<FlowData, 'plan'>;
type FlowEdge = Edge<{ label?: string; dashed?: boolean }>;

export interface GraphPatch {
  nodes: DiagramNodeInput[];
  edges: DiagramEdgeInput[];
  direction?: DiagramDirection;
}

export function FlowCanvas(props: { diagram: Diagram; onSave: (patch: GraphPatch) => Promise<boolean>; expanded?: boolean }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

const nodeTypes = { plan: memo(PlanNode) };

function Canvas({ diagram, onSave, expanded }: { diagram: Diagram; onSave: (patch: GraphPatch) => Promise<boolean>; expanded?: boolean }) {
  const theme = useResolvedTheme();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<FlowNode[]>(() => toFlowNodes(diagram));
  const [edges, setEdges] = useState<FlowEdge[]>(() => toFlowEdges(diagram));
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const dragging = useRef(false);

  // The plan object is replaced on every broadcast, so follow the graph's
  // content rather than its identity — otherwise a comment elsewhere in the
  // plan would reset the canvas mid-gesture.
  const signature = useMemo(() => JSON.stringify([diagram.nodes, diagram.edges, diagram.direction]), [diagram]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes((prev) => keepSelection(prev, toFlowNodes(diagram)));
    setEdges((prev) => keepSelection(prev, toFlowEdges(diagram)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content
  }, [signature]);

  // Growing to full screen (or back) leaves the graph in a corner; refit it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 200 }));
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, flow]);

  const persist = useCallback(
    (ns: FlowNode[], es: FlowEdge[], direction?: DiagramDirection) =>
      onSave({
        nodes: ns.map((n) => ({
          id: n.id,
          label: n.data.label,
          kind: n.data.kind,
          ...(n.data.detail ? { detail: n.data.detail } : {}),
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
        ...(direction ? { direction } : {}),
      }),
    [onSave],
  );

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (edgesRef.current.some((e) => e.source === conn.source && e.target === conn.target)) return;
      const next = [...edgesRef.current, makeEdge({ id: `${conn.source}->${conn.target}`, source: conn.source, target: conn.target })];
      setEdges(next);
      void persist(nodesRef.current, next);
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
      void persist(ns, es);
    },
    [persist],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, moved: FlowNode[]) => {
      dragging.current = false;
      const at = new Map(moved.map((n) => [n.id, n.position]));
      const ns = nodesRef.current.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n));
      void persist(ns, edgesRef.current);
    },
    [persist],
  );

  const updateNode = (id: string, patch: Partial<Pick<FlowData, 'label' | 'kind' | 'detail'>>) => {
    const ns = nodesRef.current.map((n) => {
      if (n.id !== id) return n;
      const data = { ...n.data, ...patch };
      if (!data.detail) delete data.detail;
      return { ...n, data: { ...data, width: nodeSize(data).width } };
    });
    setNodes(ns);
    void persist(ns, edgesRef.current);
  };

  const updateEdge = (id: string, patch: { label?: string; dashed?: boolean }) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const data = { ...e.data, ...patch };
      if (!data.label) delete data.label;
      return makeEdge({ id: e.id, source: e.source, target: e.target, ...data }, e.selected);
    });
    setEdges(es);
    void persist(nodesRef.current, es);
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
    void persist(ns, edgesRef.current);
  };

  const relayout = (direction: DiagramDirection) => {
    const graph = {
      nodes: nodesRef.current.map((n) => ({ id: n.id, label: n.data.label, kind: n.data.kind, ...(n.data.detail ? { detail: n.data.detail } : {}) })),
      edges: edgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    const at = autoLayout(graph, direction);
    const ns = nodesRef.current.map((n) => ({
      ...n,
      position: at.get(n.id) ?? n.position,
      data: { ...n.data, direction },
    }));
    setNodes(ns);
    void persist(ns, edgesRef.current, direction).then(() => window.requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 250 })));
  };

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);

  return (
    <div ref={wrapper} className={classNames('flow', expanded && 'is-expanded')}>
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
        {expanded && <MiniMap pannable zoomable position="bottom-right" />}
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
        {selectedNodes.length + selectedEdges.length > 0 && (
          <Panel position="top-right" className="flow-inspector">
            {selectedNodes.length === 1 && selectedEdges.length === 0 ? (
              <NodeInspector key={selectedNodes[0]!.id} node={selectedNodes[0]!} onChange={(patch) => updateNode(selectedNodes[0]!.id, patch)} onRemove={removeSelected} />
            ) : selectedEdges.length === 1 && selectedNodes.length === 0 ? (
              <EdgeInspector key={selectedEdges[0]!.id} edge={selectedEdges[0]!} nodes={nodes} onChange={(patch) => updateEdge(selectedEdges[0]!.id, patch)} onRemove={removeSelected} />
            ) : (
              <div className="flow-inspector-body">
                <p className="muted">
                  {selectedNodes.length} box(es), {selectedEdges.length} arrow(s) selected
                </p>
                <button type="button" className="btn btn-sm btn-danger" onClick={removeSelected}>
                  Delete selection
                </button>
              </div>
            )}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Nodes and edges
 * ------------------------------------------------------------------ */

function PlanNode({ data, selected }: NodeProps<FlowNode>) {
  const horizontal = data.direction === 'LR';
  return (
    <div className={classNames('flow-node', `kind-${data.kind}`, selected && 'is-selected')} style={{ width: data.width }}>
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} />
      <div className="flow-node-head">
        <span className="flow-node-glyph" aria-hidden="true">
          {KIND_GLYPH[data.kind]}
        </span>
        <span className="flow-node-label">{data.label}</span>
      </div>
      {data.detail && <div className="flow-node-detail">{data.detail}</div>}
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} />
    </div>
  );
}

function toFlowNodes(diagram: Diagram): FlowNode[] {
  const at = resolvePositions(diagram);
  return diagram.nodes.map((n) => ({
    id: n.id,
    type: 'plan' as const,
    position: at.get(n.id) ?? { x: 0, y: 0 },
    data: {
      label: n.label,
      kind: n.kind,
      ...(n.detail ? { detail: n.detail } : {}),
      direction: diagram.direction,
      width: nodeSize(n).width,
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
 * Toolbar and inspector
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

/** A text input that commits on Enter or blur, not on every keystroke. */
function CommitInput({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      className="input"
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

function NodeInspector({
  node,
  onChange,
  onRemove,
}: {
  node: FlowNode;
  onChange: (patch: Partial<Pick<FlowData, 'label' | 'kind' | 'detail'>>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flow-inspector-body" aria-label="Selected box">
      <label className="field">
        <span className="field-label">Label</span>
        <CommitInput value={node.data.label} label="Box label" onCommit={(label) => label && onChange({ label })} />
      </label>
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
        <span className="field-label">Detail</span>
        <CommitInput value={node.data.detail ?? ''} label="Box detail" placeholder="Responsibility, technology…" onCommit={(detail) => onChange({ detail })} />
      </label>
      <div className="flow-inspector-foot">
        <span className="item-id">{node.id}</span>
        <span className="spacer" />
        <button type="button" className="link is-danger" onClick={onRemove}>
          Delete box
        </button>
      </div>
    </div>
  );
}

function EdgeInspector({
  edge,
  nodes,
  onChange,
  onRemove,
}: {
  edge: FlowEdge;
  nodes: FlowNode[];
  onChange: (patch: { label?: string; dashed?: boolean }) => void;
  onRemove: () => void;
}) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  return (
    <div className="flow-inspector-body" aria-label="Selected arrow">
      <p className="flow-inspector-title">
        {name(edge.source)} → {name(edge.target)}
      </p>
      <label className="field">
        <span className="field-label">Label</span>
        <CommitInput value={edge.data?.label ?? ''} label="Arrow label" placeholder="What flows along it" onCommit={(label) => onChange({ label })} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={Boolean(edge.data?.dashed)} onChange={(e) => onChange({ dashed: e.target.checked })} />
        Dashed — optional, async or future
      </label>
      <div className="flow-inspector-foot">
        <span className="spacer" />
        <button type="button" className="link is-danger" onClick={onRemove}>
          Delete arrow
        </button>
      </div>
    </div>
  );
}
