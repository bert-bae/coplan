import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react';
import { store, useStore } from '../store.ts';
import { autoLayout, findFreeSpot, nodeSize, resolveLayout, samePoint, type Layout, type Point } from '../lib/layout.ts';
import { lanes } from '../lib/geometry.ts';
import { clipOrigin, parseClip, pasteClip, serializeClip, toClip, type Clip } from '../lib/clipboard.ts';
import { useResolvedTheme } from '../lib/theme.ts';
import { classNames } from '../lib/format.ts';
import { countTasks, descendants } from '../../shared/plan.ts';
import { NODE_KINDS, type Diagram, type DiagramDirection, type DiagramEdgeInput, type DiagramNodeInput, type NodeKind, type Plan, type TaskCounts } from '../../shared/types.ts';
import { PlanNode } from './flow/PlanNode.tsx';
import { PlanEdge } from './flow/PlanEdge.tsx';
import { EdgePanel, NodePanel, SelectionPanel } from './flow/Panels.tsx';
import { CanvasContext, KIND_GLYPH, KIND_LABEL, type CanvasApi, type EdgeData, type EdgePatch, type FlowData, type FlowEdge, type FlowNode, type NodePatch } from './flow/shared.ts';

export { KIND_GLYPH, KIND_LABEL };

/**
 * The architecture workspace: a React Flow canvas with a details panel beside
 * it.
 *
 * The canvas is where the shape of the system is decided. Add a box from the
 * toolbar, by double-clicking empty space, or by dragging an arrow out of a
 * box into space; connect boxes by dragging from any edge of one onto
 * another; rename in place with a double-click; copy, cut, paste and
 * duplicate with the usual keys; Backspace deletes. The panel is where each
 * part is decided: what it is, what it does, what was decided about it, and
 * the tasks that build it; select an arrow to say what flows along it and
 * how it is drawn.
 *
 * Every change saves the whole graph back. Where boxes sit is saved too,
 * but it is layout, not design: Claude is never told about it.
 */

export interface GraphPatch {
  nodes: DiagramNodeInput[];
  edges: DiagramEdgeInput[];
  direction?: DiagramDirection;
  /** The diagram revision this graph was edited from. */
  expect?: number;
}

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

const nodeTypes = { plan: PlanNode };
const edgeTypes = { plan: PlanEdge };

/** The last selection copied on this page, for when the system clipboard
 *  cannot be read. */
let lastClip: Clip | null = null;

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
  // Laid out once on mount; both pieces of state start from the same layout.
  const [initial] = useState(() => toFlow(diagram, plan));
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(initial.edges);
  const [editing, setEditing] = useState<string | null>(null);
  /** A box just made, whose name the panel should be ready to take. */
  const [fresh, setFresh] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const planRef = useRef(plan);
  planRef.current = plan;
  const dragging = useRef(false);
  const queue = useRef<{ pending: GraphPatch | null; busy: boolean }>({ pending: null, busy: false });
  /** Where the pointer is on the canvas, in flow coordinates, for pasting. */
  const pointer = useRef<Point | null>(null);
  const pastes = useRef(0);

  // The plan object is replaced on every broadcast, so follow the graph's
  // content rather than its identity — otherwise a comment elsewhere in the
  // plan would reset the canvas mid-gesture.
  const signature = useMemo(() => JSON.stringify([diagram.nodes, diagram.edges, diagram.direction]), [diagram]);
  /** The revision the canvas's own state was loaded from. Saves are made
   *  against it, so a change that landed elsewhere since is never overwritten
   *  — not even one that arrived mid-drag, while the canvas was not listening. */
  const baseRev = useRef(diagram.rev);

  const load = useCallback((source: Diagram, p: Plan) => {
    const next = toFlow(source, p);
    setNodes((prev) => keepSelection(prev, next.nodes));
    setEdges((prev) => keepRoutes(prev, keepSelection(prev, next.edges), next.nodes));
    baseRev.current = source.rev;
  }, []);

  useEffect(() => {
    // Mid-gesture or mid-save the canvas is ahead of the server; the save
    // queue reconciles once it drains.
    if (dragging.current || queue.current.busy || queue.current.pending) return;
    load(diagram, plan);
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

  /* ---------------------------- saving ----------------------------- */

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
  const latest = () => store.getState().session?.plan?.diagrams.find((d) => d.id === diagram.id);

  const resyncFromServer = useCallback(() => {
    const p = store.getState().session?.plan;
    const current = p?.diagrams.find((d) => d.id === diagram.id);
    if (p && current) load(current, p);
  }, [diagram.id, load]);

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
    const now = latest();
    if (now && now.rev !== baseRev.current) resyncFromServer();
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
          // Sent even when empty: leaving them out would keep the old text.
          description: n.data.description ?? '',
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
          ...(e.data?.arrows ? { arrows: e.data.arrows } : {}),
        })),
        // A patch waiting behind the one in flight is replaced, not merged —
        // except for the direction, which only the relayout ever sets.
        ...((direction ?? superseded?.direction) ? { direction: direction ?? superseded?.direction } : {}),
      };
      void flush();
    },
    [flush],
  );

  /** Replace the graph and save it, in one step. */
  const commit = useCallback(
    (ns: FlowNode[], es: FlowEdge[], direction?: DiagramDirection) => {
      setNodes(ns);
      setEdges(es);
      persist(ns, es, direction);
    },
    [persist],
  );

  /* ---------------------------- editing ---------------------------- */

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const connect = useCallback(
    (source: string, target: string, base: FlowEdge[] = edgesRef.current, ns: FlowNode[] = nodesRef.current) => {
      if (source === target || base.some((e) => e.source === source && e.target === target)) return false;
      commit(ns, [...base, makeEdge({ id: freeEdgeId(base, source, target), source, target })]);
      return true;
    },
    [commit],
  );

  const onConnect = useCallback((conn: Connection) => conn.source && conn.target && connect(conn.source, conn.target), [connect]);

  const addNode = useCallback(
    (kind: NodeKind, opts: { at?: Point; from?: string } = {}) => {
      const ns = nodesRef.current;
      let k = ns.length + 1;
      while (ns.some((x) => x.id === `n${k}`)) k++;
      const id = `n${k}`;
      const data = sized({ label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, width: 0, height: 0 });
      const lr = diagram.direction === 'LR';
      let want: Point;
      if (opts.at) want = { x: opts.at.x - data.width / 2, y: opts.at.y - data.height / 2 };
      else if (opts.from) {
        const src = ns.find((n) => n.id === opts.from)!;
        want = lr ? { x: src.position.x + src.data.width + 90, y: src.position.y } : { x: src.position.x, y: src.position.y + src.data.height + 90 };
      } else {
        const rect = wrapper.current?.getBoundingClientRect();
        const c = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
        want = { x: c.x - data.width / 2, y: c.y - data.height / 2 };
      }
      // Dropped exactly where the pointer is; otherwise in the nearest free spot.
      const position = opts.at ? round(want) : findFreeSpot(want, data, positionsOf(ns), sizesOf(ns), lr);
      const node: FlowNode = { id, type: 'plan', position, data, selected: true };
      const nextNodes = [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), node];
      const base = edgesRef.current.map((e) => (e.selected ? { ...e, selected: false } : e));
      const nextEdges = opts.from ? [...base, makeEdge({ id: freeEdgeId(base, opts.from, id), source: opts.from, target: id })] : base;
      commit(nextNodes, nextEdges);
      setFresh(id);
      setEditing(`node:${id}`);
    },
    [commit, diagram.direction, flow],
  );

  /** An arrow dropped somewhere other than a handle: onto a box connects to
   *  it, into empty space makes a new box there. */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const hit = document.elementFromPoint?.(point.clientX, point.clientY) ?? null;
      const onNode = hit?.closest('.react-flow__node')?.getAttribute('data-id');
      if (onNode) {
        if (onNode !== state.fromNode.id) connect(state.fromNode.id, onNode);
        return;
      }
      if (hit?.closest('.react-flow__pane')) {
        addNode('component', { at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), from: state.fromNode.id });
      }
    },
    [addNode, connect, flow],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      const goneIds = new Set(gone.map((n) => n.id));
      const cutIds = new Set(cut.map((e) => e.id));
      commit(
        nodesRef.current.filter((n) => !goneIds.has(n.id)),
        edgesRef.current.filter((e) => !cutIds.has(e.id) && !goneIds.has(e.source) && !goneIds.has(e.target)),
      );
    },
    [commit],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, moved: FlowNode[]) => {
      dragging.current = false;
      const at = new Map(moved.map((n) => [n.id, n.position]));
      persist(
        nodesRef.current.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n)),
        edgesRef.current,
      );
    },
    [persist],
  );

  const updateNodes = (ids: Set<string>, patch: NodePatch) => {
    const ns = nodesRef.current.map((n) => {
      if (!ids.has(n.id)) return n;
      const data: FlowData = { ...n.data, ...patch };
      for (const key of ['detail', 'description', 'notes'] as const) if (!data[key]) delete data[key];
      return { ...n, data: { ...sized(data), ...progressOf(planRef.current, data.taskIds) } };
    });
    commit(ns, edgesRef.current);
  };
  const updateNode = (id: string, patch: NodePatch) => updateNodes(new Set([id]), patch);

  const updateEdge = (id: string, patch: EdgePatch) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const source = patch.source ?? e.source;
      const target = patch.target ?? e.target;
      const data: EdgeData = { ...e.data, ...patch };
      delete (data as EdgePatch).source;
      delete (data as EdgePatch).target;
      if (!data.label) delete data.label;
      if (!data.arrows) delete data.arrows;
      if (!data.dashed) delete data.dashed;
      // The route was for the old ends.
      if (source !== e.source || target !== e.target) delete data.route;
      return makeEdge({ id: e.id, source, target, ...data }, e.selected);
    });
    commit(nodesRef.current, es);
  };

  const reverseEdge = (id: string) => {
    const e = edgesRef.current.find((x) => x.id === id);
    if (e) updateEdge(id, { source: e.target, target: e.source });
  };

  const select = useCallback((kind: 'node' | 'edge', id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })));
  }, []);

  const clearSelection = () => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
  };

  const removeSelected = useCallback(() => {
    void flow.deleteElements({ nodes: nodesRef.current.filter((n) => n.selected), edges: edgesRef.current.filter((e) => e.selected) });
  }, [flow]);

  const relayout = (direction: DiagramDirection) => {
    const at = autoLayout(graphOf(nodesRef.current, edgesRef.current), direction);
    const ns = nodesRef.current.map((n) => ({ ...n, position: at.positions.get(n.id) ?? n.position }));
    const es = edgesRef.current.map((e) => withRoute(e, at));
    commit(ns, es, direction);
    window.requestAnimationFrame(() => void flow.fitView(FIT));
  };

  /* ------------------------ copy and paste ------------------------- */

  const selectionClip = useCallback((): Clip | null => {
    const picked = nodesRef.current.filter((n) => n.selected);
    return toClip(
      picked.map((n) => ({ id: n.id, ...contentOf(n.data), x: n.position.x, y: n.position.y })),
      edgesRef.current.map((e) => ({ source: e.source, target: e.target, ...edgeContent(e.data) })),
    );
  }, []);

  const paste = useCallback(
    (clip: Clip, where: 'pointer' | 'offset') => {
      const origin = clipOrigin(clip);
      pastes.current += 1;
      const step = 32 * pastes.current;
      const at = where === 'pointer' && pointer.current ? { x: pointer.current.x - origin.x, y: pointer.current.y - origin.y } : { x: step, y: step };
      const tasks = new Set(planRef.current.tasks.map((t) => t.id));
      const made = pasteClip(clip, nodesRef.current.map((n) => n.id), tasks, at);
      const newNodes: FlowNode[] = made.nodes.map(({ id, x, y, ...content }) => ({
        id,
        type: 'plan',
        position: { x, y },
        data: { ...sized({ ...content, width: 0, height: 0 }), ...progressOf(planRef.current, content.taskIds) },
        selected: true,
      }));
      const base = edgesRef.current.map((e) => (e.selected ? { ...e, selected: false } : e));
      const newEdges = made.edges.reduce<FlowEdge[]>((es, e) => [...es, makeEdge({ id: freeEdgeId(es, e.source, e.target), ...e })], base);
      commit([...nodesRef.current.map((n) => (n.selected ? { ...n, selected: false } : n)), ...newNodes], newEdges);
      return newNodes.length;
    },
    [commit],
  );

  const copySelection = useCallback(
    (data?: DataTransfer | null) => {
      const clip = selectionClip();
      if (!clip) return false;
      lastClip = clip;
      pastes.current = 0;
      const text = serializeClip(clip);
      if (data) data.setData('text/plain', text);
      else void navigator.clipboard?.writeText(text).catch(() => undefined);
      store.toast('info', `Copied ${clip.nodes.length} box${clip.nodes.length === 1 ? '' : 'es'}. Paste with ⌘/Ctrl+V, here or in another diagram.`);
      return true;
    },
    [selectionClip],
  );

  const duplicate = useCallback(() => {
    const clip = selectionClip();
    if (!clip) return;
    pastes.current = 0;
    paste(clip, 'offset');
  }, [paste, selectionClip]);

  useEffect(() => {
    const busy = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !(el instanceof HTMLElement)) return false;
      return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    /** The canvas speaks for the clipboard when the keyboard is on it (or on
     *  nothing), and no text is selected that the user means to copy. */
    const ours = (e: Event) => {
      if (busy(e.target) || busy(document.activeElement)) return false;
      const active = document.activeElement;
      const onCanvas = !active || active === document.body || Boolean(wrapper.current?.contains(active));
      const text = window.getSelection?.()?.toString() ?? '';
      return onCanvas && !text;
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) {
        e.preventDefault();
        removeSelected();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      const text = e.clipboardData?.getData('text/plain');
      // Something else on the clipboard is not ours to paste.
      const clip = text ? parseClip(text) : lastClip;
      if (!clip) return;
      e.preventDefault();
      paste(clip, 'pointer');
    };
    const onKey = (e: KeyboardEvent) => {
      if (busy(e.target)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !wrapper.current?.contains(active)) return;
      const mod = e.metaKey || e.ctrlKey;
      const selected = nodesRef.current.filter((n) => n.selected);
      if (mod && e.key.toLowerCase() === 'd' && selected.length) {
        e.preventDefault();
        duplicate();
      } else if (mod && e.key.toLowerCase() === 'a' && !e.shiftKey) {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
        setEdges((es) => es.map((x) => ({ ...x, selected: true })));
      } else if (e.key === 'F2' && selected.length === 1) {
        e.preventDefault();
        setEditing(`node:${selected[0]!.id}`);
      } else if (e.key === 'Escape') {
        setEditing(null);
        clearSelection();
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
    };
  }, [copySelection, duplicate, paste, removeSelected]);

  /* ------------------------ canvas context ------------------------- */

  const api = useMemo<CanvasApi>(
    () => ({
      direction: diagram.direction,
      editing,
      startEditing: setEditing,
      finishNodeLabel: (id, label) => {
        setEditing(null);
        setFresh(null);
        const node = nodesRef.current.find((n) => n.id === id);
        const next = label?.trim();
        if (node && next && next !== node.data.label) updateNode(id, { label: next });
      },
      finishEdgeLabel: (id, label) => {
        setEditing(null);
        const edge = edgesRef.current.find((e) => e.id === id);
        if (edge && label !== null && label.trim() !== (edge.data?.label ?? '')) updateEdge(id, { label: label.trim() });
      },
      selectEdge: (id) => select('edge', id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updaters read live state through refs
    [diagram.direction, editing, select],
  );

  // Arrows between the same two boxes are drawn side by side.
  const drawnEdges = useMemo(() => {
    const offsets = lanes(edges);
    if (offsets.size === 0) return edges;
    return edges.map((e) => (offsets.has(e.id) ? { ...e, data: { ...e.data, lane: offsets.get(e.id)! } } : e));
  }, [edges]);

  /* ------------------------------ panel ----------------------------- */

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
        focusName={fresh === node.id && editing !== `node:${node.id}`}
        onChange={(patch) => updateNode(node.id, patch)}
        onSelect={select}
        onConnect={(target) => connect(node.id, target)}
        onDisconnect={(id) => commit(nodesRef.current, edgesRef.current.filter((e) => e.id !== id))}
        onAddConnected={() => addNode('component', { from: node.id })}
        onDuplicate={duplicate}
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
        onReverse={() => reverseEdge(edge.id)}
        onSelect={select}
        onRemove={removeSelected}
        onClose={clearSelection}
      />
    );
  } else if (selectedNodes.length + selectedEdges.length > 1) {
    panel = (
      <SelectionPanel
        nodes={selectedNodes}
        edges={selectedEdges}
        onKind={(kind) => updateNodes(new Set(selectedNodes.map((n) => n.id)), { kind })}
        onCopy={() => copySelection(null)}
        onDuplicate={duplicate}
        onRemove={removeSelected}
        onClose={clearSelection}
      />
    );
  } else {
    panel = aside;
  }

  return (
    <CanvasContext.Provider value={api}>
      <div className="arch-body">
        <div
          ref={wrapper}
          className="flow"
          onMouseMove={(e) => {
            pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => {
            pointer.current = null;
          }}
          onDoubleClick={(e) => {
            const el = e.target as HTMLElement;
            if (el.closest('.react-flow__node, .react-flow__edge, .react-flow__panel, .flow-edge-label')) return;
            if (!el.closest('.react-flow__pane')) return;
            addNode('component', { at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
          }}
        >
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes}
            edges={drawnEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onDelete={onDelete}
            onNodeDragStart={() => {
              dragging.current = true;
            }}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={(_, node) => setEditing(`node:${node.id}`)}
            onEdgeDoubleClick={(_, edge) => setEditing(`edge:${edge.id}`)}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={['Backspace', 'Delete']}
            zoomOnDoubleClick={false}
            colorMode={theme}
            fitView
            fitViewOptions={FIT}
            minZoom={0.2}
            maxZoom={2}
            defaultEdgeOptions={{ type: 'plan' }}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
            <MiniMap pannable zoomable position="bottom-right" style={{ width: 150, height: 96 }} nodeBorderRadius={4} />
            <Panel position="top-left" className="flow-toolbar">
              <AddMenu onAdd={(kind) => addNode(kind)} />
              <button type="button" className="btn btn-sm" title="Lay the whole diagram out again, along its flow" onClick={() => relayout(diagram.direction)}>
                Tidy layout
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title={diagram.direction === 'LR' ? 'Lay it out top to bottom' : 'Lay it out left to right'}
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
    </CanvasContext.Provider>
  );
}

/** Fit the whole diagram, but never blow a small one up past its real size,
 *  and never shrink a large one past legibility. */
const FIT = { padding: 0.14, maxZoom: 1, minZoom: 0.4, duration: 0 };

/* ------------------------------------------------------------------ *
 * Diagram ⇄ canvas
 * ------------------------------------------------------------------ */

function toFlow(diagram: Diagram, plan: Plan): { nodes: FlowNode[]; edges: FlowEdge[] } {
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

function makeEdge(
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

function withRoute(edge: FlowEdge, layout: Layout): FlowEdge {
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
function keepRoutes(prev: FlowEdge[], next: FlowEdge[], nodes: FlowNode[]): FlowEdge[] {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return next.map((e) => {
    if (e.data?.route) return e;
    const old = prev.find((p) => p.id === e.id && p.source === e.source && p.target === e.target)?.data?.route;
    if (old && samePoint(at.get(e.source), old.from) && samePoint(at.get(e.target), old.to)) return { ...e, data: { ...e.data, route: old } };
    return e;
  });
}

function keepSelection<T extends { id: string; selected?: boolean }>(prev: T[], next: T[]): T[] {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => (selected.has(x.id) ? { ...x, selected: true } : x));
}

function sized(data: FlowData): FlowData {
  const { width, height } = nodeSize(data);
  return { ...data, width, height };
}

function contentOf(d: FlowData) {
  return {
    label: d.label,
    kind: d.kind,
    ...(d.detail ? { detail: d.detail } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.notes ? { notes: d.notes } : {}),
    ...(d.taskIds?.length ? { taskIds: d.taskIds } : {}),
  };
}

function edgeContent(d: EdgeData | undefined) {
  return { ...(d?.label ? { label: d.label } : {}), ...(d?.dashed ? { dashed: true } : {}), ...(d?.arrows ? { arrows: d.arrows } : {}) };
}

function graphOf(ns: FlowNode[], es: FlowEdge[]) {
  return {
    nodes: ns.map((n) => ({ id: n.id, ...contentOf(n.data) })),
    edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.data?.label ? { label: e.data.label } : {}) })),
  };
}

function positionsOf(ns: FlowNode[]) {
  return new Map(ns.map((n) => [n.id, n.position]));
}

function sizesOf(ns: FlowNode[]) {
  return new Map(ns.map((n) => [n.id, { width: n.data.width, height: n.data.height }]));
}

function freeEdgeId(edges: { id: string }[], source: string, target: string): string {
  let id = `${source}->${target}`;
  for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
  return id;
}

function round(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
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

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

function AddMenu({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-menu">
      <button type="button" className="btn btn-sm btn-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Or double-click empty canvas">
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
