import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
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
import { autoLayout, findFreeSpot, type Point } from '../lib/layout.ts';
import { lanes } from '../lib/geometry.ts';
import { bridgeOver, relationsOf, splitEdge, type EdgeRelation, type Relations } from '../lib/graph.ts';
import { History } from '../lib/history.ts';
import { clipOrigin, parseClip, pasteClip, serializeClip, toClip, type Clip } from '../lib/clipboard.ts';
import { useResolvedTheme } from '../lib/theme.ts';
import { classNames } from '../lib/format.ts';
import { NODE_KINDS, type Diagram, type DiagramDirection, type DiagramEdgeInput, type DiagramNodeInput, type NodeKind, type Plan, type PlanOp } from '../../shared/types.ts';
import type { DiffMark } from '../../shared/proposals.ts';
import { PlanNode } from './flow/PlanNode.tsx';
import { PlanEdge } from './flow/PlanEdge.tsx';
import { EdgePanel, NodePanel, ReadOnlyPanel, SelectionPanel } from './flow/Panels.tsx';
import { ContextMenu, type MenuEntry } from './flow/ContextMenu.tsx';
import { ALT, MOD, ShortcutsOverlay } from './flow/Shortcuts.tsx';
import {
  contentOf,
  edgeContent,
  freeEdgeId,
  graphOf,
  keepRoutes,
  keepSelection,
  makeEdge,
  positionsOf,
  progressOf,
  round,
  signatureOf,
  sized,
  sizesOf,
  toFlow,
  withRoute,
} from './flow/convert.ts';
import { CanvasContext, KIND_GLYPH, KIND_LABEL, type CanvasApi, type EdgeData, type EdgePatch, type FlowData, type FlowEdge, type FlowNode, type NodePatch } from './flow/shared.ts';

export { KIND_GLYPH, KIND_LABEL };

/**
 * The architecture workspace: a React Flow canvas with a details panel beside
 * it.
 *
 * The canvas is where the shape of the system is decided, and it is built to
 * be fast to edit with either hand:
 *
 * - **Adding** — the toolbar, a double-click or right-click on empty canvas,
 *   dragging an arrow into space, or from a selected box: Tab for the next
 *   box along the flow, Shift+Tab for one before it, Enter for one beside it.
 * - **Connecting** — drag from any edge of a box onto another; drag either
 *   end of an arrow to move it; drop an unconnected box on an arrow to put it
 *   in between.
 * - **Editing** — type on a selected box to rename it; copy, cut, paste,
 *   duplicate; delete, or delete keeping the flow; undo and redo.
 * - **Seeing** — hover or select a box and everything it connects to lights
 *   up by direction, the rest fades; hold Alt for two steps out.
 * - **Tasks** — every box but a note counts the tasks that build it, and
 *   its chip (or Alt+Enter) opens their list, where one is added, renamed
 *   or unlinked without leaving the canvas.
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
  /** The design is confirmed or submitted: show it, change nothing. */
  readOnly?: boolean;
  /** Why it is read-only, for the badge on the canvas. */
  lockNote?: string;
  /** While the design is confirmed but not yet submitted, which tasks build
   *  each box can still change. */
  onLinkTasks?: (nodeId: string, taskIds: string[]) => void;
  /** Task edits made from a box — adding one that builds it. Resolves with
   *  the plan as the daemon left it, or null when refused. Without it, a
   *  box's task list is only read. */
  onTaskOps?: (ops: PlanOp[]) => Promise<Plan | null>;
  /** A proposal's preview: which boxes and arrows it adds, changes or
   *  takes away, marked on the canvas. */
  diff?: CanvasDiff;
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

/** A whole graph, as undo keeps it. */
interface Snapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
  direction: DiagramDirection;
}

/** A task added from a box, waiting its turn among the canvas's saves. */
interface TaskJob {
  nodeId: string;
  title: string;
  done: (ok: boolean) => void;
}

/** Where a new box goes relative to one already there. */
type Near = { id: string; where: 'after' | 'before' | 'beside' };

type MenuTarget = { kind: 'pane' } | { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'selection' };

interface Reconnect {
  edgeId: string;
  end: 'source' | 'target';
  pointer: Point;
  /** The box the end would move to, if dropped now. */
  over: string | null;
}

/** Colour of a highlighted arrow and its head, by how it relates to the focus. */
const REL_COLOUR: Record<EdgeRelation, string> = {
  out: 'var(--rel-to)',
  out2: 'var(--rel-to)',
  in: 'var(--rel-from)',
  in2: 'var(--rel-from)',
  both: 'var(--rel-both)',
};

function Editor({
  diagram,
  plan,
  onSave,
  aside,
  readOnly = false,
  lockNote,
  onLinkTasks,
  onTaskOps,
  diff,
}: {
  diagram: Diagram;
  plan: Plan;
  onSave: (patch: GraphPatch) => Promise<number | null>;
  aside: ReactNode;
  readOnly?: boolean;
  lockNote?: string;
  onLinkTasks?: (nodeId: string, taskIds: string[]) => void;
  onTaskOps?: (ops: PlanOp[]) => Promise<Plan | null>;
  diff?: CanvasDiff;
}) {
  const theme = useResolvedTheme();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLElement>(null);
  // Laid out once on mount; both pieces of state start from the same layout.
  const [initial] = useState(() => toFlow(diagram, plan));
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(initial.edges);
  const [editing, setEditingState] = useState<string | null>(null);
  const [editSeed, setEditSeed] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [twoHops, setTwoHops] = useState(false);
  const [menu, setMenu] = useState<{ at: Point; flow: Point; target: MenuTarget } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [reconnect, setReconnect] = useState<Reconnect | null>(null);
  const [dropEdge, setDropEdge] = useState<string | null>(null);
  /** The box whose task list is open. */
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const [, setHistoryTick] = useState(0);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const planRef = useRef(plan);
  planRef.current = plan;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const dragging = useRef(false);
  const queue = useRef<{ pending: GraphPatch | null; busy: boolean; jobs: TaskJob[] }>({ pending: null, busy: false, jobs: [] });
  /** Where the pointer is on the canvas, in flow coordinates, for pasting. */
  const pointer = useRef<Point | null>(null);
  const pastes = useRef(0);

  const setEditing = useCallback((key: string | null, seed: string | null = null) => {
    setEditSeed(seed);
    setEditingState(key);
  }, []);

  // The plan object is replaced on every broadcast, so follow the graph's
  // content rather than its identity — otherwise a comment elsewhere in the
  // plan would reset the canvas mid-gesture.
  const signature = useMemo(() => signatureOf(diagram), [diagram]);
  /** The graph the canvas last loaded, by signature. */
  const loaded = useRef(signature);
  /** A keyboard nudge waiting to be saved. */
  const nudge = useRef<number | undefined>(undefined);
  /** The revision the canvas's own state was loaded from. Saves are made
   *  against it, so a change that landed elsewhere since is never overwritten
   *  — not even one that arrived mid-drag, while the canvas was not listening. */
  const baseRev = useRef(diagram.rev);

  /* ---------------------------- history ----------------------------- */

  const history = useRef(new History<Snapshot>());
  /** The graph as last saved or loaded: what an undo steps back from. */
  const current = useRef<Snapshot>({ nodes: initial.nodes, edges: initial.edges, direction: diagram.direction });
  /** The same, as the save it would send — so an edit that changes nothing
   *  is neither saved nor recorded. */
  const currentKey = useRef(JSON.stringify(patchOf(initial.nodes, initial.edges, diagram.direction)));
  /** Revisions this canvas produced. A load of any other means someone else
   *  — Claude, another tab — changed the diagram, and undoing past that
   *  would quietly revert their change. */
  const ownRevs = useRef(new Set<number>([diagram.rev]));
  const historyLost = useRef(false);
  const bumpHistory = () => setHistoryTick((n) => n + 1);

  const load = useCallback((source: Diagram, p: Plan) => {
    const next = toFlow(source, p);
    const ns = keepSelection(nodesRef.current, next.nodes);
    const es = keepRoutes(edgesRef.current, keepSelection(edgesRef.current, next.edges), next.nodes);
    setNodes(ns);
    setEdges(es);
    baseRev.current = source.rev;
    loaded.current = signatureOf(source);
    current.current = { nodes: ns, edges: es, direction: source.direction };
    const key = JSON.stringify(patchOf(ns, es, source.direction));
    // The boxes and arrows are what undo steps through. A new revision that
    // left them as they were (a title or caption edited beside the canvas)
    // reverts nothing anyone did, so the history stands.
    const sameGraph = key === currentKey.current;
    currentKey.current = key;
    if (sameGraph) ownRevs.current.add(source.rev);
    if (!ownRevs.current.has(source.rev)) {
      if (history.current.canUndo || history.current.canRedo) historyLost.current = true;
      history.current.clear();
      setHistoryTick((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    // Mid-gesture or mid-save the canvas is ahead of the server; the save
    // queue reconciles once it drains.
    if (dragging.current || nudge.current !== undefined || queue.current.busy || queue.current.pending) return;
    if (loaded.current !== signature) load(diagram, plan);
    // The revision moved without the graph changing — the title or caption
    // was edited. Nothing to redraw, but the next save is made against it.
    else baseRev.current = diagram.rev;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content
  }, [signature, diagram.rev]);

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
    const box = `node:${diagram.id}:`;
    const arrow = `edge:${diagram.id}:`;
    if (focusTarget?.startsWith(box)) {
      const id = focusTarget.slice(box.length);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      setEdges((es) => es.map((e) => ({ ...e, selected: false })));
      window.requestAnimationFrame(() => void flow.fitView({ nodes: [{ id }], padding: 1.2, duration: 250, maxZoom: 1.2 }));
    } else if (focusTarget?.startsWith(arrow)) {
      // An arrow: select it, and bring both its ends in.
      const id = focusTarget.slice(arrow.length);
      const edge = diagram.edges.find((e) => e.id === id);
      setEdges((es) => es.map((e) => ({ ...e, selected: e.id === id })));
      setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
      if (edge) window.requestAnimationFrame(() => void flow.fitView({ nodes: [{ id: edge.source }, { id: edge.target }], padding: 1.2, duration: 250, maxZoom: 1.2 }));
    } else return;
    store.set({ focusTarget: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the target
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
    const now = p?.diagrams.find((d) => d.id === diagram.id);
    if (p && now) load(now, p);
  }, [diagram.id, load]);

  /** Tell the page whether an edit here is not yet saved: Confirm and Submit
   *  wait for it, and leaving the page warns. */
  const syncSaving = () => {
    const q = queue.current;
    const busy = q.busy || Boolean(q.pending) || nudge.current !== undefined;
    if (store.getState().canvasSaving !== busy) store.set({ canvasSaving: busy });
  };

  /** Runs a task added from a box; set once it is defined, below. */
  const taskJob = useRef<(job: TaskJob) => Promise<boolean>>(async () => false);

  const flush = useCallback(async () => {
    const q = queue.current;
    if (q.busy) return;
    q.busy = true;
    syncSaving();
    try {
      while (q.pending || q.jobs.length) {
        // The graph first: a task added to a box just drawn needs the box
        // saved before it.
        if (!q.pending) {
          const job = q.jobs.shift()!;
          job.done(await taskJob.current(job));
          continue;
        }
        const patch = q.pending;
        q.pending = null;
        const savedRev = await onSave({ ...patch, expect: baseRev.current });
        if (savedRev !== null) {
          // Build on the revision this save produced — not on whatever the
          // store holds now, which may include a change the canvas never loaded.
          baseRev.current = savedRev;
          ownRevs.current.add(savedRev);
        } else {
          // Refused — changed elsewhere, or invalid — and with it any edit
          // still pending. History no longer matches what is saved: the
          // refused save may have been an undo, a redo or several edits at
          // once, so no one step can be taken out. It goes, as it does when
          // the diagram changes elsewhere; then show what is really saved.
          q.pending = null;
          history.current.clear();
          historyLost.current = true;
          bumpHistory();
          resyncFromServer();
        }
      }
    } finally {
      q.busy = false;
      syncSaving();
    }
    // Something newer than our last save may have arrived while we were busy
    // and been held back; take it now.
    const now = latest();
    if (now && now.rev !== baseRev.current) resyncFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state through refs
  }, [onSave, resyncFromServer]);

  /**
   * A task added from a box. It is a task edit, not a drawing one — undo
   * leaves it be, as it leaves a task added in the Tasks view — but it links
   * the box, which moves the diagram on. So it takes its turn among the
   * canvas's saves, and the link is carried into what the canvas holds (the
   * boxes, the graph as last saved, its undo history and any save still
   * waiting) rather than reloaded over them. If anything else changed the
   * diagram meanwhile, the canvas reloads as it would for that change.
   */
  const runTaskJob = async ({ nodeId, title }: TaskJob): Promise<boolean> => {
    if (!onTaskOps) return false;
    const known = new Set((store.getState().session?.plan ?? planRef.current).tasks.map((t) => t.id));
    for (const t of planRef.current.tasks) known.add(t.id);
    const from = baseRev.current;
    const after = await onTaskOps([{ op: 'upsert_task', title, builds: [`${diagram.id}/${nodeId}`] }]);
    if (!after) return false;
    const saved = after.diagrams.find((d) => d.id === diagram.id);
    const fresh = (saved?.nodes.find((n) => n.id === nodeId)?.taskIds ?? []).filter((t) => !known.has(t));
    const task = fresh.length > 1 ? (fresh.find((t) => after.tasks.find((x) => x.id === t)?.title === title.trim()) ?? fresh[0]) : fresh[0];
    if (!saved || !task || readOnlyRef.current || saved.rev !== from + 1) return true;
    baseRev.current = saved.rev;
    ownRevs.current.add(saved.rev);
    const link = (ns: FlowNode[]) =>
      ns.map((n) => (n.id !== nodeId || n.data.taskIds?.includes(task) ? n : { ...n, data: { ...n.data, taskIds: [...(n.data.taskIds ?? []), task] } }));
    history.current.map((snap) => ({ ...snap, nodes: link(snap.nodes) }));
    const cur = current.current;
    current.current = { ...cur, nodes: link(cur.nodes) };
    currentKey.current = JSON.stringify(patchOf(current.current.nodes, cur.edges, cur.direction));
    const q = queue.current;
    if (q.pending) {
      q.pending = { ...q.pending, nodes: q.pending.nodes.map((n) => (n.id !== nodeId || n.taskIds?.includes(task) ? n : { ...n, taskIds: [...(n.taskIds ?? []), task] })) };
    }
    setNodes((ns) => link(ns).map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...progressOf(after, n.data.taskIds) } } : n)));
    return true;
  };
  taskJob.current = runTaskJob;

  /**
   * Save a graph — every edit on the canvas comes through here, so this is
   * also where undo history is kept. An edit that changes nothing saves and
   * records nothing.
   */
  const persist = useCallback(
    (ns: FlowNode[], es: FlowEdge[], direction?: DiagramDirection, opts: { record?: boolean } = {}) => {
      // A submitted plan is final; whatever path got here, nothing is saved.
      if (readOnlyRef.current) return;
      const dir = direction ?? current.current.direction;
      const patch = patchOf(ns, es, dir);
      const key = JSON.stringify(patch);
      if (key === currentKey.current && !queue.current.pending) return;
      if (opts.record !== false) {
        history.current.record(current.current);
        historyLost.current = false;
        bumpHistory();
      }
      current.current = { nodes: ns, edges: es, direction: dir };
      currentKey.current = key;
      // Only a relayout or an undo across one says which way the diagram
      // flows; every other save leaves it as the daemon has it.
      const superseded = queue.current.pending;
      const { direction: _dir, ...graph } = patch;
      const flowDir = direction ?? superseded?.direction;
      queue.current.pending = { ...graph, ...(flowDir ? { direction: flowDir } : {}) };
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

  /** Put a remembered graph back on the canvas and save it. */
  const restore = useCallback(
    (snap: Snapshot) => {
      const selected = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
      // A task removed since the snapshot cannot be linked back: the save
      // would be refused, and every undo after it with it.
      const tasks = new Set(planRef.current.tasks.map((t) => t.id));
      const ns = snap.nodes.map((n) => {
        const taskIds = n.data.taskIds?.filter((id) => tasks.has(id));
        return {
          ...n,
          selected: selected.has(n.id),
          // Progress moves on whatever is undone; show it as it is now.
          data: { ...n.data, taskIds, ...progressOf(planRef.current, taskIds) },
        };
      });
      const es = snap.edges.map((e) => ({ ...e, selected: false }));
      setNodes(ns);
      setEdges(es);
      setEditing(null);
      persist(ns, es, snap.direction !== current.current.direction ? snap.direction : undefined, { record: false });
      bumpHistory();
    },
    [persist, setEditing],
  );

  const undo = useCallback(() => {
    const before = history.current.undo(current.current);
    if (before) return restore(before);
    store.toast(
      'info',
      historyLost.current ? 'Nothing to undo: this diagram was changed elsewhere since your last edit, and undoing past that would revert it.' : 'Nothing to undo.',
    );
  }, [restore]);

  const redo = useCallback(() => {
    const after = history.current.redo(current.current);
    if (after) restore(after);
  }, [restore]);

  /* ---------------------------- editing ---------------------------- */

  const onNodesChange = useCallback(
    (all: NodeChange<FlowNode>[]) => {
      // Read-only: selecting and measuring, never moving or removing.
      const changes = readOnlyRef.current ? all.filter((c) => c.type !== 'position' && c.type !== 'remove') : all;
      if (changes.length === 0) return;
      setNodes((ns) => applyNodeChanges(changes, ns));
      // Arrow keys move selected boxes through here rather than as a drag,
      // so nothing else would save them. Save once the keys stop; a drag's
      // own moves are saved when it ends.
      if (dragging.current || !changes.some((c) => c.type === 'position' && c.position && !c.dragging)) return;
      window.clearTimeout(nudge.current);
      nudge.current = window.setTimeout(() => {
        nudge.current = undefined;
        persist(nodesRef.current, edgesRef.current);
        syncSaving();
      }, 300);
      syncSaving();
    },
    [persist],
  );
  // Leaving the diagram within the nudge delay still saves the move.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(
    () => () => {
      if (nudge.current === undefined) return;
      window.clearTimeout(nudge.current);
      nudge.current = undefined;
      persistRef.current(nodesRef.current, edgesRef.current);
      // A move that came back to where it started saves nothing, and then
      // nothing else would say the canvas is done saving.
      const q = queue.current;
      if (!q.busy && !q.pending) store.set({ canvasSaving: false });
    },
    [],
  );
  const onEdgesChange = useCallback(
    (all: EdgeChange<FlowEdge>[]) => {
      const changes = readOnlyRef.current ? all.filter((c) => c.type !== 'remove') : all;
      if (changes.length) setEdges((es) => applyEdgeChanges(changes, es));
    },
    [],
  );

  const connect = useCallback(
    (source: string, target: string, base: FlowEdge[] = edgesRef.current, ns: FlowNode[] = nodesRef.current) => {
      if (source === target || base.some((e) => e.source === source && e.target === target)) return false;
      commit(ns, [...base, makeEdge({ id: freeEdgeId(base, source, target), source, target })]);
      return true;
    },
    [commit],
  );

  const onConnect = useCallback((conn: Connection) => conn.source && conn.target && connect(conn.source, conn.target), [connect]);

  /** Bring a box into view if it is off the visible canvas. */
  const reveal = useCallback(
    (id: string) => {
      window.requestAnimationFrame(() => {
        const node = flow.getInternalNode(id);
        const rect = wrapper.current?.getBoundingClientRect();
        if (!node || !rect?.width) return;
        const { x, y, zoom } = flow.getViewport();
        const w = node.measured.width ?? node.data.width;
        const h = node.measured.height ?? node.data.height;
        const sx = node.internals.positionAbsolute.x * zoom + x;
        const sy = node.internals.positionAbsolute.y * zoom + y;
        if (sx < 0 || sy < 0 || sx + w * zoom > rect.width || sy + h * zoom > rect.height) {
          void flow.setCenter(node.internals.positionAbsolute.x + w / 2, node.internals.positionAbsolute.y + h / 2, { zoom, duration: 200 });
        }
      });
    },
    [flow],
  );

  /** A fresh id for a new box. */
  const newId = () => {
    const ns = nodesRef.current;
    let k = ns.length + 1;
    while (ns.some((x) => x.id === `n${k}`)) k++;
    return `n${k}`;
  };

  /**
   * Add a box — anywhere it is asked for — select it and start naming it.
   * `at` drops it exactly there; `near` puts it in the nearest free spot
   * after, before or beside another box; otherwise it goes in the middle of
   * the view. `from` and `to` are the boxes it is connected from and to.
   */
  const addNode = useCallback(
    (kind: NodeKind, opts: { at?: Point; near?: Near; from?: string[]; to?: string[] } = {}) => {
      const ns = nodesRef.current;
      const id = newId();
      const data = sized({ label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, width: 0, height: 0 });
      const lr = diagram.direction === 'LR';
      const anchor = opts.near && ns.find((n) => n.id === opts.near!.id);
      let want: Point;
      if (opts.at) want = { x: opts.at.x - data.width / 2, y: opts.at.y - data.height / 2 };
      else if (anchor) {
        const { x, y } = anchor.position;
        const { width: w, height: h } = anchor.data;
        const gap = 90;
        want = {
          after: lr ? { x: x + w + gap, y } : { x, y: y + h + gap },
          before: lr ? { x: x - gap - data.width, y } : { x, y: y - gap - data.height },
          beside: lr ? { x, y: y + h + 40 } : { x: x + w + 50, y },
        }[opts.near!.where];
      } else {
        const rect = wrapper.current?.getBoundingClientRect();
        const c = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
        want = { x: c.x - data.width / 2, y: c.y - data.height / 2 };
      }
      // Dropped exactly where the pointer is; otherwise in the nearest free
      // spot, looking across the flow — which is also the way a box beside
      // stacks up.
      const position = opts.at ? round(want) : findFreeSpot(want, data, positionsOf(ns), sizesOf(ns), lr);
      const node: FlowNode = { id, type: 'plan', position, data, selected: true };
      const nextNodes = [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), node];
      let nextEdges = edgesRef.current.map((e) => (e.selected ? { ...e, selected: false } : e));
      for (const s of opts.from ?? []) nextEdges = [...nextEdges, makeEdge({ id: freeEdgeId(nextEdges, s, id), source: s, target: id })];
      for (const t of opts.to ?? []) nextEdges = [...nextEdges, makeEdge({ id: freeEdgeId(nextEdges, id, t), source: id, target: t })];
      commit(nextNodes, nextEdges);
      setEditing(`node:${id}`);
      reveal(id);
      return id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newId reads live state through refs
    [commit, diagram.direction, flow, reveal, setEditing],
  );

  /** A box after the selected one along the flow, connected from it. */
  const addAfter = useCallback((id: string) => addNode('component', { near: { id, where: 'after' }, from: [id] }), [addNode]);
  /** A box before it, connected to it. */
  const addBefore = useCallback((id: string) => addNode('component', { near: { id, where: 'before' }, to: [id] }), [addNode]);
  /** A box beside it: the same kind, fed by the same boxes. */
  const addBeside = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      const parents = [...new Set(edgesRef.current.filter((e) => e.target === id && e.source !== id).map((e) => e.source))];
      addNode(node.data.kind === 'note' ? 'component' : node.data.kind, { near: { id, where: 'beside' }, from: parents });
    },
    [addNode],
  );

  /** Put a new box into an arrow, at a point along it. */
  const insertIntoEdge = useCallback(
    (edgeId: string, at: Point) => {
      const edge = edgesRef.current.find((e) => e.id === edgeId);
      if (!edge) return;
      const id = newId();
      const data = sized({ label: 'New component', kind: 'component', width: 0, height: 0 });
      const node: FlowNode = { id, type: 'plan', position: round({ x: at.x - data.width / 2, y: at.y - data.height / 2 }), data, selected: true };
      const ns = nodesRef.current.map((x) => (x.selected ? { ...x, selected: false } : x));
      commit([...ns, node], spliced(edgesRef.current, edge, id));
      setEditing(`node:${id}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newId reads live state through refs
    [commit, setEditing],
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
        addNode('component', { at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), from: [state.fromNode.id] });
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

  /** Delete the selection, joining what flowed into it to what it flowed
   *  out to: A→B→C without B is A→C. */
  const removeKeepingFlow = useCallback(() => {
    const gone = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    const cut = new Set(edgesRef.current.filter((e) => e.selected).map((e) => e.id));
    if (!gone.size && !cut.size) return;
    const { kept, bridges } = bridgeOver(gone, edgesRef.current.filter((e) => !cut.has(e.id)).map(liteEdge));
    const keep = new Set(kept.map((k) => k.id));
    let es = edgesRef.current.filter((e) => keep.has(e.id));
    for (const b of bridges) es = [...es, makeEdge({ id: freeEdgeId(es, b.source, b.target), ...b })];
    commit(
      nodesRef.current.filter((n) => !gone.has(n.id)),
      es,
    );
    if (bridges.length) store.toast('info', `Deleted, and joined ${bridges.length} connection${bridges.length === 1 ? '' : 's'} around it.`);
  }, [commit]);

  /** While one unconnected box is dragged, the arrow it is over — where it
   *  would be put if dropped. */
  const onNodeDrag = useCallback((event: { clientX: number; clientY: number }, node: FlowNode, moving: FlowNode[]) => {
    const free = moving.length === 1 && !edgesRef.current.some((e) => e.source === node.id || e.target === node.id);
    const under = free ? (document.elementsFromPoint?.(event.clientX, event.clientY) ?? []) : [];
    const hit = under.map((el) => el.closest('.react-flow__edge')?.getAttribute('data-id')).find(Boolean) ?? null;
    setDropEdge((was) => (was === hit ? was : hit));
  }, []);

  /** A drag of one box, or of a selection by its rectangle, is over. */
  const onDragStop = useCallback(
    (moved: FlowNode[], into: string | null = null) => {
      dragging.current = false;
      setDropEdge(null);
      const at = new Map(moved.map((n) => [n.id, n.position]));
      const ns = nodesRef.current.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n));
      const edge = into && edgesRef.current.find((e) => e.id === into);
      if (edge && moved.length === 1) commit(ns, spliced(edgesRef.current, edge, moved[0]!.id));
      else persist(ns, edgesRef.current);
    },
    [commit, persist],
  );
  const dropEdgeRef = useRef(dropEdge);
  dropEdgeRef.current = dropEdge;
  const onNodeDragStop = useCallback((_: unknown, __: FlowNode, moved: FlowNode[]) => onDragStop(moved, dropEdgeRef.current), [onDragStop]);
  const onSelectionDragStop = useCallback((_: unknown, moved: FlowNode[]) => onDragStop(moved), [onDragStop]);
  const onDragStart = useCallback(() => {
    dragging.current = true;
    setMenu(null);
  }, []);

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
  const updateEdgeRef = useRef(updateEdge);
  updateEdgeRef.current = updateEdge;

  const reverseEdge = (id: string) => {
    const e = edgesRef.current.find((x) => x.id === id);
    if (e) updateEdge(id, { source: e.target, target: e.source });
  };

  const select = useCallback((kind: 'node' | 'edge', id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })));
  }, []);

  const clearSelection = useCallback(() => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
  }, []);

  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    setEdges((es) => es.map((x) => ({ ...x, selected: true })));
  }, []);

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

  const fitAll = useCallback(() => void flow.fitView({ ...FIT, duration: 200 }), [flow]);
  const fitSelection = useCallback(() => {
    const picked = nodesRef.current.filter((n) => n.selected);
    if (!picked.length) return fitAll();
    void flow.fitView({ nodes: picked.map((n) => ({ id: n.id })), padding: 0.5, maxZoom: 1.25, duration: 200 });
  }, [fitAll, flow]);

  /* ------------------------ copy and paste ------------------------- */

  const selectionClip = useCallback((): Clip | null => {
    const picked = nodesRef.current.filter((n) => n.selected);
    return toClip(
      picked.map((n) => ({ id: n.id, ...contentOf(n.data), x: n.position.x, y: n.position.y })),
      edgesRef.current.map((e) => ({ source: e.source, target: e.target, ...edgeContent(e.data) })),
    );
  }, []);

  /** Paste a copied selection: at the pointer, at a given point, or offset
   *  from where it was copied. */
  const paste = useCallback(
    (clip: Clip, where: 'pointer' | 'offset' | Point) => {
      const origin = clipOrigin(clip);
      pastes.current += 1;
      const step = 32 * pastes.current;
      const point = where === 'pointer' ? pointer.current : where === 'offset' ? null : where;
      const at = point ? { x: point.x - origin.x, y: point.y - origin.y } : { x: step, y: step };
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
      store.toast('info', `Copied ${clip.nodes.length} box${clip.nodes.length === 1 ? '' : 'es'}. Paste with ${MOD}V, here or in another diagram.`);
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

  /* ---------------------- reconnecting an end ----------------------- */

  const startReconnect = useCallback((edgeId: string, end: 'source' | 'target', e: { clientX: number; clientY: number }) => {
    setMenu(null);
    setReconnect({ edgeId, end, pointer: { x: e.clientX, y: e.clientY }, over: null });
  }, []);

  useEffect(() => {
    if (!reconnect) return;
    const edge = edgesRef.current.find((x) => x.id === reconnect.edgeId);
    const fixed = edge ? (reconnect.end === 'source' ? edge.target : edge.source) : null;
    const boxAt = (x: number, y: number) => {
      const hit = document.elementFromPoint?.(x, y)?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
      return hit && hit !== fixed ? hit : null;
    };
    const move = (ev: PointerEvent) => setReconnect((r) => r && { ...r, pointer: { x: ev.clientX, y: ev.clientY }, over: boxAt(ev.clientX, ev.clientY) });
    const up = (ev: PointerEvent) => {
      const over = boxAt(ev.clientX, ev.clientY);
      setReconnect(null);
      if (edge && over && over !== edge[reconnect.end]) updateEdgeRef.current(edge.id, { [reconnect.end]: over });
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setReconnect(null);
    };
    // Let go outside the window, or the gesture taken away: nothing moves.
    const cancel = () => setReconnect(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
    };
    // Bound once per gesture, not on every pointer move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnect?.edgeId, reconnect?.end]);

  /* ---------------------------- hovering ---------------------------- */

  // Leaving an arrow for one of its grips must not hide the grips on the
  // way: clearing waits a moment, and entering either keeps them.
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverEdge = useCallback((id: string | null) => {
    window.clearTimeout(hoverTimer.current);
    if (id) setHoverEdgeId(id);
    else hoverTimer.current = window.setTimeout(() => setHoverEdgeId(null), 160);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  /* ----------------------------- menus ------------------------------ */

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = useCallback(
    (client: Point, target: MenuTarget) => {
      const rect = wrapper.current?.getBoundingClientRect();
      if (!rect) return;
      setMenu({ at: { x: client.x - rect.left, y: client.y - rect.top }, flow: flow.screenToFlowPosition(client), target });
    },
    [flow],
  );

  /** Shift+F10 or the menu key: the menu for whatever is selected, opened
   *  beside it. */
  const openMenuForSelection = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const picked = nodesRef.current.filter((n) => n.selected);
    const lines = edgesRef.current.filter((e) => e.selected);
    const centreOf = (id: string): Point => {
      const n = flow.getInternalNode(id);
      if (!n) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return flow.flowToScreenPosition({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
    };
    if (picked.length === 1 && !lines.length) return openMenu(centreOf(picked[0]!.id), { kind: 'node', id: picked[0]!.id });
    if (lines.length === 1 && !picked.length) {
      const a = centreOf(lines[0]!.source);
      const b = centreOf(lines[0]!.target);
      return openMenu({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { kind: 'edge', id: lines[0]!.id });
    }
    if (picked.length + lines.length > 1) return openMenu(centreOf(picked[0]?.id ?? ''), { kind: 'selection' });
    openMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { kind: 'pane' });
  }, [flow, openMenu]);

  const kindChoices = (active: NodeKind | null) =>
    NODE_KINDS.map((k) => ({
      value: k,
      label: KIND_LABEL[k],
      className: `kind-${k}`,
      active: k === active,
      content: (
        <span className="kind-swatch" aria-hidden="true">
          {KIND_GLYPH[k]}
        </span>
      ),
    }));

  const menuEntries = (target: MenuTarget, at: Point): { title: string; entries: MenuEntry[] } => {
    if (target.kind === 'pane') {
      return {
        title: 'Canvas',
        entries: [
          { kind: 'choices', label: 'Add a box here', options: kindChoices(null), onSelect: (k) => addNode(k as NodeKind, { at }) },
          { kind: 'item', label: 'Paste here', hint: `${MOD}V`, disabled: !lastClip, onSelect: () => lastClip && paste(lastClip, at) },
          { kind: 'separator' },
          { kind: 'item', label: 'Select everything', hint: `${MOD}A`, onSelect: selectAll },
          { kind: 'item', label: 'Tidy layout', onSelect: () => relayout(diagram.direction) },
          { kind: 'item', label: 'Fit the whole diagram', hint: '⇧1', onSelect: fitAll },
          { kind: 'separator' },
          { kind: 'item', label: 'Undo', hint: `${MOD}Z`, disabled: !history.current.canUndo, onSelect: undo },
          { kind: 'item', label: 'Keyboard shortcuts', hint: '?', onSelect: () => setShortcuts(true) },
        ],
      };
    }
    if (target.kind === 'node') {
      const node = nodesRef.current.find((n) => n.id === target.id);
      if (!node) return { title: 'Box', entries: [] };
      const targets = new Set(edgesRef.current.filter((e) => e.source === node.id).map((e) => e.target));
      const others = nodesRef.current.filter((n) => n.id !== node.id && !targets.has(n.id));
      return {
        title: node.data.label,
        entries: [
          { kind: 'item', label: 'Rename', hint: 'F2', onSelect: () => setEditing(`node:${node.id}`) },
          { kind: 'choices', label: 'Kind', options: kindChoices(node.data.kind), onSelect: (k) => updateNode(node.id, { kind: k as NodeKind }) },
          ...(node.data.kind !== 'note' ? [{ kind: 'item' as const, label: 'Tasks that build it…', hint: `${ALT}Enter`, onSelect: () => showTasks(node.id) }] : []),
          { kind: 'separator' },
          { kind: 'item', label: 'Add a box after it', hint: 'Tab', onSelect: () => addAfter(node.id) },
          { kind: 'item', label: 'Add a box before it', hint: '⇧Tab', onSelect: () => addBefore(node.id) },
          { kind: 'item', label: 'Add a box beside it', hint: 'Enter', onSelect: () => addBeside(node.id) },
          {
            kind: 'submenu',
            label: 'Connect to',
            entries: others.length
              ? others.map((n) => ({ kind: 'item' as const, label: n.data.label, onSelect: () => connect(node.id, n.id) }))
              : [{ kind: 'item' as const, label: 'Already connected to every box', disabled: true, onSelect: () => undefined }],
          },
          { kind: 'separator' },
          { kind: 'item', label: 'Copy', hint: `${MOD}C`, onSelect: () => copySelection(null) },
          { kind: 'item', label: 'Duplicate', hint: `${MOD}D`, onSelect: duplicate },
          { kind: 'separator' },
          { kind: 'item', label: 'Delete, keeping the flow', hint: `${ALT}⌫`, onSelect: removeKeepingFlow },
          { kind: 'item', label: 'Delete', hint: '⌫', danger: true, onSelect: removeSelected },
        ],
      };
    }
    if (target.kind === 'edge') {
      const edge = edgesRef.current.find((e) => e.id === target.id);
      if (!edge) return { title: 'Connection', entries: [] };
      const name = (id: string) => nodesRef.current.find((n) => n.id === id)?.data.label ?? id;
      return {
        title: `${name(edge.source)} → ${name(edge.target)}`,
        entries: [
          { kind: 'item', label: edge.data?.label ? 'Edit label' : 'Add a label', onSelect: () => setEditing(`edge:${edge.id}`) },
          { kind: 'item', label: 'Reverse direction', onSelect: () => reverseEdge(edge.id) },
          { kind: 'check', label: 'Dashed — optional, async or future', checked: Boolean(edge.data?.dashed), onSelect: () => updateEdge(edge.id, { dashed: !edge.data?.dashed }) },
          {
            kind: 'choices',
            label: 'Arrowheads',
            options: (
              [
                ['end', '→', 'One way'],
                ['both', '↔', 'Both ways'],
                ['none', '—', 'No direction'],
              ] as const
            ).map(([value, glyph, label]) => ({ value, label, active: (edge.data?.arrows ?? 'end') === value, content: glyph })),
            onSelect: (v) => updateEdge(edge.id, { arrows: v === 'end' ? undefined : (v as 'both' | 'none') }),
          },
          { kind: 'separator' },
          { kind: 'item', label: 'Insert a box here', onSelect: () => insertIntoEdge(edge.id, at) },
          { kind: 'item', label: 'Delete', hint: '⌫', danger: true, onSelect: removeSelected },
        ],
      };
    }
    const picked = nodesRef.current.filter((n) => n.selected);
    const kinds = new Set(picked.map((n) => n.data.kind));
    return {
      title: `${picked.length} box${picked.length === 1 ? '' : 'es'} selected`,
      entries: [
        ...(picked.length
          ? [
              {
                kind: 'choices' as const,
                label: 'Kind of every box',
                options: kindChoices(kinds.size === 1 ? [...kinds][0]! : null),
                onSelect: (k: string) => updateNodes(new Set(picked.map((n) => n.id)), { kind: k as NodeKind }),
              },
              { kind: 'separator' as const },
              { kind: 'item' as const, label: 'Copy', hint: `${MOD}C`, onSelect: () => copySelection(null) },
              { kind: 'item' as const, label: 'Duplicate', hint: `${MOD}D`, onSelect: duplicate },
              { kind: 'item' as const, label: 'Zoom to them', hint: '⇧2', onSelect: fitSelection },
              { kind: 'separator' as const },
              { kind: 'item' as const, label: 'Delete, keeping the flow', hint: `${ALT}⌫`, onSelect: removeKeepingFlow },
            ]
          : []),
        { kind: 'item', label: 'Delete', hint: '⌫', danger: true, onSelect: removeSelected },
      ],
    };
  };

  /* --------------------------- keyboard ----------------------------- */

  /** Open a box's task list, or close it. A note has none. */
  const showTasks = useCallback((id: string | null) => {
    setMenu(null);
    setTasksFor(id && nodesRef.current.some((n) => n.id === id && n.data.kind !== 'note') ? id : null);
  }, []);

  const keys = useRef({ undo, redo, duplicate, selectAll, addAfter, addBefore, addBeside, removeKeepingFlow, fitAll, fitSelection, openMenuForSelection, clearSelection, showTasks });
  keys.current = { undo, redo, duplicate, selectAll, addAfter, addBefore, addBeside, removeKeepingFlow, fitAll, fitSelection, openMenuForSelection, clearSelection, showTasks };
  const overlays = useRef({ menu: false, shortcuts: false, reconnect: false });
  overlays.current = { menu: Boolean(menu), shortcuts, reconnect: Boolean(reconnect) };

  useEffect(() => {
    const busy = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !(el instanceof HTMLElement)) return false;
      return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    /** A box's task list keeps every key: Tab, Enter, Escape and typing are
     *  how it is used, and it closes itself. */
    const inTasks = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('.flow-tasks'));
    /** Keys belong to the canvas when the keyboard is on it — or on nothing
     *  in particular: the page, or the view around the canvas, which takes
     *  focus when empty canvas is clicked. A control elsewhere keeps them. */
    const onCanvas = () => {
      const active = document.activeElement;
      const canvas = wrapper.current;
      if (!active || !canvas) return true;
      return canvas.contains(active) || active.contains(canvas);
    };
    /** The canvas speaks for the clipboard when the keyboard is on it, and no
     *  text is selected that the user means to copy. */
    const ours = (e: Event) => {
      if (busy(e.target) || busy(document.activeElement) || inTasks(document.activeElement)) return false;
      const text = window.getSelection?.()?.toString() ?? '';
      return onCanvas() && !text;
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (readOnlyRef.current || !ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) {
        e.preventDefault();
        removeSelected();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (readOnlyRef.current || !ours(e)) return;
      const text = e.clipboardData?.getData('text/plain');
      // Something else on the clipboard is not ours to paste.
      const clip = text ? parseClip(text) : lastClip;
      if (!clip) return;
      e.preventDefault();
      paste(clip, 'pointer');
    };
    /** A control on the canvas — a toolbar button, the zoom controls, the
     *  minimap — keeps Tab, Enter and typing: they are how it is used and
     *  left, not a box being worked on. */
    const onControl = () => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !wrapper.current?.contains(active) || active === wrapper.current) return false;
      if (active.closest('.react-flow__node')) return Boolean(active.closest('button, a[href], [role="button"]'));
      return Boolean(active.closest('.react-flow__panel, .react-flow__controls, .react-flow__minimap, button, a[href], [role="button"]'));
    };
    /** F6 moves the keyboard between the canvas and its details panel. */
    const toggleRegion = () => {
      const canvas = wrapper.current;
      const side = details.current;
      if (!canvas || !side) return false;
      const active = document.activeElement;
      if (active && side.contains(active)) {
        const one = nodesRef.current.find((n) => n.selected);
        const node = one ? [...canvas.querySelectorAll<HTMLElement>('.react-flow__node')].find((el) => el.dataset.id === one.id) : undefined;
        (node ?? canvas).focus();
        return true;
      }
      if (!onCanvas()) return false;
      const first = side.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
      (first ?? side).focus();
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setTwoHops(true);
      if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey && !overlays.current.menu && !overlays.current.shortcuts) {
        if (toggleRegion()) e.preventDefault();
        return;
      }
      if (busy(e.target) || inTasks(e.target) || !onCanvas()) return;
      const o = overlays.current;
      if (o.menu || o.shortcuts || o.reconnect) return;
      const k = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const selected = nodesRef.current.filter((n) => n.selected);
      const one = selected.length === 1 && !edgesRef.current.some((x) => x.selected) ? selected[0]! : null;
      // A claimed key stops here, so the app's single-key shortcuts (the
      // tabs, the sidebar) do not also fire while a box is being worked on.
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (readOnlyRef.current) {
        // Looking, not editing: select, fit and clear — nothing that changes it.
        if (mod && key === 'a' && !e.shiftKey) return claim(), k.selectAll();
        if (!mod && e.shiftKey && e.code === 'Digit1') return claim(), k.fitAll();
        if (!mod && e.shiftKey && e.code === 'Digit2') return claim(), k.fitSelection();
        if (e.key === 'Enter' && e.altKey && one && !onControl()) return claim(), k.showTasks(one.id);
        if (e.key === 'Escape') k.clearSelection();
        return;
      }
      if (mod) {
        if (key === 'z') return claim(), e.shiftKey ? k.redo() : k.undo();
        if (key === 'y') return claim(), k.redo();
        if (key === 'd' && selected.length) return claim(), k.duplicate();
        if (key === 'a' && !e.shiftKey) return claim(), k.selectAll();
        return;
      }
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') return claim(), k.openMenuForSelection();
      if (e.key === '?') return claim(), setShortcuts(true);
      if (e.shiftKey && e.code === 'Digit1') return claim(), k.fitAll();
      if (e.shiftKey && e.code === 'Digit2') return claim(), k.fitSelection();
      if ((e.key === 'Backspace' || e.key === 'Delete') && e.altKey && selected.length) return claim(), k.removeKeepingFlow();
      if (e.key === 'Escape') {
        setEditing(null);
        k.clearSelection();
        return;
      }
      if (!one || onControl()) return;
      if (e.key === 'Enter' && e.altKey) return claim(), k.showTasks(one.id);
      if (e.key === 'Tab') return claim(), e.shiftKey ? k.addBefore(one.id) : k.addAfter(one.id);
      if (e.key === 'Enter' && !e.altKey) return claim(), k.addBeside(one.id);
      if (e.key === 'F2') return claim(), setEditing(`node:${one.id}`);
      // Typing on a selected box renames it, starting from what was typed.
      if (e.key.length === 1 && e.key !== ' ' && !e.altKey) return claim(), setEditing(`node:${one.id}`, e.key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setTwoHops(false);
    };
    const onBlur = () => setTwoHops(false);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [copySelection, paste, removeSelected, setEditing]);

  /* ------------------------ canvas context ------------------------- */

  // A box's tasks can be changed from it until the plan is submitted: while
  // drawing, and once the design is confirmed. A preview only shows them.
  const tasksEditable = Boolean(onTaskOps) && (!readOnly || Boolean(onLinkTasks));
  // The box whose list was open may have gone.
  const tasksOpen = tasksFor && nodes.some((n) => n.id === tasksFor) ? tasksFor : null;
  // Both change identity with every render of the view around the canvas;
  // the boxes should not re-render for that.
  const live = useRef({ flush, onLinkTasks });
  live.current = { flush, onLinkTasks };
  const api = useMemo<CanvasApi>(
    () => ({
      direction: diagram.direction,
      editing: readOnly ? null : editing,
      editSeed,
      startEditing: (key) => {
        if (!readOnly) setEditing(key);
      },
      startReconnect: (edgeId, end, event) => {
        if (!readOnly) startReconnect(edgeId, end, event);
      },
      hoverEdge,
      finishNodeLabel: (id, label) => {
        setEditing(null);
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
      tasksOpen,
      showTasks,
      tasksEditable,
      addTask: (nodeId, title) =>
        new Promise<boolean>((done) => {
          if (!tasksEditable) return done(false);
          queue.current.jobs.push({ nodeId, title, done });
          void live.current.flush();
        }),
      unlinkTask: (nodeId, taskId) => {
        const node = nodesRef.current.find((n) => n.id === nodeId);
        if (!node || !tasksEditable) return;
        const taskIds = (node.data.taskIds ?? []).filter((t) => t !== taskId);
        // As "Built by" in the panel does: a link edit on the canvas, which
        // undo can put back — or, once the design is confirmed, on the plan.
        if (readOnly) live.current.onLinkTasks?.(nodeId, taskIds);
        else updateNode(nodeId, { taskIds });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updaters read live state through refs
    [diagram.direction, editing, editSeed, select, startReconnect, hoverEdge, setEditing, readOnly, tasksOpen, showTasks, tasksEditable],
  );

  /* ------------------------ what is drawn -------------------------- */

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);

  // What is in focus, and so what lights up: the box under the pointer (a
  // preview), else the one selected; an arrow likewise lights up its ends.
  const gesturing = Boolean(reconnect) || dragging.current;
  const focusNode = (!gesturing && hoverNode) || (selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0]!.id : null);
  const focusEdge = focusNode ? null : (!gesturing && hoverEdgeId) || (selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0]!.id : null);
  const relations = useMemo<Relations | null>(() => {
    const lite = edges.map(liteEdge);
    if (focusNode && nodes.some((n) => n.id === focusNode)) return relationsOf(focusNode, lite, twoHops ? 2 : 1);
    const e = focusEdge ? lite.find((x) => x.id === focusEdge) : undefined;
    if (!e) return null;
    const both = e.arrows === 'both' || e.arrows === 'none';
    return {
      nodes: new Map([
        [e.source, both ? ('both' as const) : ('from' as const)],
        [e.target, both ? ('both' as const) : ('to' as const)],
      ]),
      edges: new Map([[e.id, both ? ('both' as const) : ('out' as const)]]),
    };
  }, [edges, nodes, focusNode, focusEdge, twoHops]);

  const drawnNodes = useMemo(
    () =>
      nodes.map((n) => {
        const rel = relations?.nodes.get(n.id);
        const dim = Boolean(relations) && !rel;
        const drop = reconnect?.over === n.id;
        const mark = diff?.nodes[n.id];
        if (!rel && !dim && !drop && !mark) return n;
        return {
          ...n,
          className: classNames(dim && 'rel-dim', rel && `rel-${rel}`, mark && `diff-${mark}`),
          ...(mark ? { ariaLabel: `${n.data.label} (${DIFF_WORDS[mark]})` } : {}),
          data: { ...n.data, ...(rel ? { rel } : {}), ...(drop ? { dropTarget: true } : {}) },
        };
      }),
    [nodes, relations, reconnect?.over, diff],
  );

  // Arrows between the same two boxes are drawn side by side; arrows tied to
  // the focus are coloured by direction and flow from source to target.
  const drawnEdges = useMemo(() => {
    const offsets = lanes(edges);
    return edges.map((e) => {
      const rel = relations?.edges.get(e.id);
      const dim = Boolean(relations) && !rel;
      const grips = !readOnly && !reconnect && e.source !== e.target && (Boolean(e.selected) || hoverEdgeId === e.id);
      const lane = offsets.get(e.id);
      const drop = dropEdge === e.id;
      const moving = reconnect?.edgeId === e.id;
      const mark = diff?.edges[e.id];
      if (!rel && !dim && !grips && lane === undefined && !drop && !moving && !mark) return e;
      const colour = rel ? REL_COLOUR[rel] : undefined;
      const marker = (m: FlowEdge['markerEnd']) => (m && typeof m === 'object' && colour ? { ...m, color: colour } : m);
      return {
        ...e,
        className: classNames(e.className, rel && `rel-${rel}`, dim && 'rel-dim', drop && 'is-drop-target', moving && 'is-reconnecting', mark && `diff-${mark}`),
        animated: rel === 'out' || rel === 'in' || rel === 'out2' || rel === 'in2',
        markerEnd: marker(e.markerEnd),
        markerStart: marker(e.markerStart),
        data: { ...e.data, ...(lane !== undefined ? { lane } : {}), ...(rel ? { rel } : {}), ...(dim ? { dim } : {}), ...(grips ? { grips } : {}), ...(drop ? { dropTarget: true } : {}) },
      };
    });
  }, [edges, relations, reconnect, hoverEdgeId, dropEdge, readOnly, diff]);

  /* ------------------------------ panel ----------------------------- */

  let panel: ReactNode;
  if (readOnly && selectedNodes.length + selectedEdges.length > 0) {
    panel = (
      <ReadOnlyPanel
        nodes={nodes}
        edges={edges}
        selectedNodes={selectedNodes}
        selectedEdges={selectedEdges}
        plan={plan}
        onSelect={select}
        onClose={clearSelection}
        {...(onLinkTasks ? { onLinkTasks } : {})}
      />
    );
  } else if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0]!;
    panel = (
      <NodePanel
        key={node.id}
        diagramId={diagram.id}
        node={node}
        nodes={nodes}
        edges={edges}
        plan={plan}
        {...(diagram.nodes.some((n) => n.id === node.id) ? { commentTarget: { kind: 'node' as const, id: `${diagram.id}/${node.id}` } } : {})}
        onChange={(patch) => updateNode(node.id, patch)}
        onSelect={select}
        onConnect={(target) => connect(node.id, target)}
        onDisconnect={(id) => commit(nodesRef.current, edgesRef.current.filter((e) => e.id !== id))}
        onAddConnected={() => addAfter(node.id)}
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
        plan={plan}
        {...(diagram.edges.some((e) => e.id === edge.id) ? { commentTarget: { kind: 'edge' as const, id: `${diagram.id}/${edge.id}` } } : {})}
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

  const shownMenu = menu ? menuEntries(menu.target, menu.flow) : null;
  const focusLabel = focusNode ? (nodes.find((n) => n.id === focusNode)?.data.label ?? '') : 'this connection';

  return (
    <CanvasContext.Provider value={api}>
      <div className="arch-body">
        <div
          ref={wrapper}
          tabIndex={-1}
          role="region"
          aria-label="Diagram canvas"
          className={classNames('flow', reconnect && 'is-reconnecting', readOnly && 'is-readonly')}
          onMouseMove={(e) => {
            pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => {
            pointer.current = null;
          }}
          onDoubleClick={(e) => {
            if (readOnly) return;
            const el = e.target as HTMLElement;
            if (el.closest('.react-flow__node, .react-flow__edge, .react-flow__panel, .flow-edge-label, .flow-menu')) return;
            if (!el.closest('.react-flow__pane')) return;
            addNode('component', { at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
          }}
        >
          <ReactFlow<FlowNode, FlowEdge>
            nodes={drawnNodes}
            edges={drawnEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onConnectEnd={readOnly ? undefined : onConnectEnd}
            onDelete={readOnly ? undefined : onDelete}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            onNodeDragStart={onDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionDragStart={onDragStart}
            onSelectionDragStop={onSelectionDragStop}
            onNodeDoubleClick={(_, node) => !readOnly && setEditing(`node:${node.id}`)}
            onEdgeDoubleClick={(_, edge) => !readOnly && setEditing(`edge:${edge.id}`)}
            onNodeMouseEnter={(_, node) => setHoverNode(node.id)}
            onNodeMouseLeave={() => setHoverNode(null)}
            onEdgeMouseEnter={(_, edge) => hoverEdge(edge.id)}
            onEdgeMouseLeave={() => hoverEdge(null)}
            onPaneContextMenu={(e) => {
              if (readOnly) return;
              e.preventDefault();
              openMenu({ x: e.clientX, y: e.clientY }, { kind: 'pane' });
            }}
            onNodeContextMenu={(e, node) => {
              if (readOnly) return;
              e.preventDefault();
              const many = nodesRef.current.filter((n) => n.selected).length + edgesRef.current.filter((x) => x.selected).length > 1;
              if (node.selected && many) return openMenu({ x: e.clientX, y: e.clientY }, { kind: 'selection' });
              select('node', node.id);
              openMenu({ x: e.clientX, y: e.clientY }, { kind: 'node', id: node.id });
            }}
            onEdgeContextMenu={(e, edge) => {
              if (readOnly) return;
              e.preventDefault();
              select('edge', edge.id);
              openMenu({ x: e.clientX, y: e.clientY }, { kind: 'edge', id: edge.id });
            }}
            onSelectionContextMenu={(e) => {
              if (readOnly) return;
              e.preventDefault();
              openMenu({ x: e.clientX, y: e.clientY }, { kind: 'selection' });
            }}
            onMoveStart={() => setMenu(null)}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
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
            {readOnly ? (
              <Panel position="top-left" className="flow-toolbar">
                <span className="flow-locked" title={lockNote ?? 'The plan is submitted; reopen it to change the design'}>
                  <span aria-hidden="true">🔒</span> {onLinkTasks ? 'Design confirmed' : 'Final design'}
                </span>
              </Panel>
            ) : (
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
              <span className="flow-toolbar-group">
                <button type="button" className="btn btn-sm btn-icon" aria-label="Undo" title={`Undo (${MOD}Z)`} disabled={!history.current.canUndo} onClick={undo}>
                  ↶
                </button>
                <button type="button" className="btn btn-sm btn-icon" aria-label="Redo" title={`Redo (⇧${MOD}Z)`} disabled={!history.current.canRedo} onClick={redo}>
                  ↷
                </button>
              </span>
              <button type="button" className="btn btn-sm btn-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setShortcuts(true)}>
                ?
              </button>
            </Panel>
            )}
            {relations && (
              <Panel position="bottom-center" className="flow-legend">
                <span className="flow-legend-item rel-from" title="Boxes with an arrow into it">
                  from →
                </span>
                <span className="flow-legend-item rel-focus">{focusLabel}</span>
                <span className="flow-legend-item rel-to" title="Boxes it has an arrow to">
                  → to
                </span>
                <span className="flow-legend-item rel-both" title="Connected both ways, or without a direction">
                  ⇄ both
                </span>
                {focusNode && <span className="flow-legend-hint">{twoHops ? 'two steps out' : `hold ${ALT === '⌥' ? '⌥' : 'Alt'} for two steps`}</span>}
              </Panel>
            )}
          </ReactFlow>
          {reconnect && <ReconnectLine reconnect={reconnect} edges={edges} wrapper={wrapper.current} />}
          {menu && shownMenu && <ContextMenu at={menu.at} title={shownMenu.title} entries={shownMenu.entries} onClose={closeMenu} />}
          {shortcuts && <ShortcutsOverlay onClose={() => setShortcuts(false)} />}
        </div>
        <aside ref={details} className="arch-panel" aria-label="Details" tabIndex={-1}>
          {panel}
        </aside>
      </div>
    </CanvasContext.Provider>
  );
}

/** Fit the whole diagram, but never blow a small one up past its real size,
 *  and never shrink a large one past legibility. */
const FIT = { padding: 0.14, maxZoom: 1, minZoom: 0.4, duration: 0 };

/** Which boxes and arrows a previewed proposal adds, changes or takes away. */
export interface CanvasDiff {
  nodes: Record<string, DiffMark>;
  edges: Record<string, DiffMark>;
}

/** Said to a screen reader along with the box's name: colour alone is not enough. */
const DIFF_WORDS: Record<DiffMark, string> = { added: 'proposed: added', changed: 'proposed: changed', removed: 'proposed: removed' };

/** What a save sends for a graph. */
function patchOf(ns: FlowNode[], es: FlowEdge[], direction: DiagramDirection): GraphPatch & { direction: DiagramDirection } {
  return {
    nodes: ns.map((n) => ({
      id: n.id,
      label: n.data.label,
      kind: n.data.kind,
      detail: n.data.detail ?? '',
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
      // Always said, even when empty: the daemon keeps an arrow's label
      // and style when an edit leaves them out.
      label: e.data?.label ?? '',
      dashed: Boolean(e.data?.dashed),
      arrows: e.data?.arrows ?? 'end',
    })),
    direction,
  };
}

function liteEdge(e: FlowEdge) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.data?.label ? { label: e.data.label } : {}),
    ...(e.data?.dashed ? { dashed: true } : {}),
    ...(e.data?.arrows ? { arrows: e.data.arrows } : {}),
  };
}

/** The arrows with `edge` replaced by its two halves through box `id`. */
function spliced(edges: FlowEdge[], edge: FlowEdge, id: string): FlowEdge[] {
  const [first, second] = splitEdge(liteEdge(edge), id);
  let out = edges.filter((e) => e.id !== edge.id);
  for (const half of [first, second]) out = [...out, makeEdge({ id: freeEdgeId(out, half.source, half.target), ...half })];
  return out;
}

/** While an arrow's end is dragged: a line from the end that stays to the
 *  pointer, with the head where the arrow will point. */
function ReconnectLine({ reconnect, edges, wrapper }: { reconnect: Reconnect; edges: FlowEdge[]; wrapper: HTMLDivElement | null }) {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const edge = edges.find((e) => e.id === reconnect.edgeId);
  const rect = wrapper?.getBoundingClientRect();
  if (!edge || !rect) return null;
  const fixedId = reconnect.end === 'source' ? edge.target : edge.source;
  const n = flow.getInternalNode(fixedId);
  if (!n) return null;
  const c = flow.flowToScreenPosition({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
  const fixed = { x: c.x - rect.left, y: c.y - rect.top };
  const moving = { x: reconnect.pointer.x - rect.left, y: reconnect.pointer.y - rect.top };
  const [from, to] = reconnect.end === 'target' ? [fixed, moving] : [moving, fixed];
  return (
    <svg className="flow-reconnect" aria-hidden="true">
      <defs>
        <marker id="flow-reconnect-head" viewBox="-10 -10 20 20" markerWidth="14" markerHeight="14" orient="auto-start-reverse" refX="0" refY="0">
          <polyline points="-5,-4 0,0 -5,4 -5,-4" />
        </marker>
      </defs>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#flow-reconnect-head)" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

function AddMenu({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-menu">
      <button type="button" className="btn btn-sm btn-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Or double-click or right-click empty canvas">
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
